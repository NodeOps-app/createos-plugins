import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, test } from "node:test";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import createosExtension from "../index.ts";
import { sandboxExec as executeInSandbox } from "./cli.ts";
import {
  createArchiveArgs,
  createExtractCommand,
  selectStartupSync,
  syncProjectOnce,
  syncSkillDirectories,
  validateLocalSyncSource,
} from "./startup-sync.ts";

function createExtensionHarness(flagValues: Record<string, boolean> = {}) {
  const registeredFlags: string[] = [];
  const registeredTools: Array<{ name?: string }> = [];
  const registeredCommands = new Map<
    string,
    { handler: (args: string, ctx: never) => Promise<void> }
  >();
  const execCalls: Array<{ command: string; args: string[] }> = [];
  let sessionStart: ((event: never, ctx: never) => Promise<void>) | undefined;
  let userBash: (() => unknown) | undefined;
  const pi = {
    registerFlag: (name: string) => registeredFlags.push(name),
    registerTool: (tool: { name?: string }) => registeredTools.push(tool),
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: never) => Promise<void> },
    ) => registeredCommands.set(name, command),
    on: (event: string, handler: (...args: never[]) => unknown) => {
      if (event === "session_start")
        sessionStart = handler as unknown as (event: never, ctx: never) => Promise<void>;
      if (event === "user_bash") userBash = handler as unknown as () => unknown;
    },
    getFlag: (name: string) => flagValues[name],
    exec: async (command: string, args: string[]) => {
      execCalls.push({ command, args });
      if (args.join(" ") === "-o json sandbox network ls")
        return { code: 0, stdout: "[]", stderr: "" };
      return { code: args[0] === "version" ? 0 : 1, stdout: "", stderr: "" };
    },
  };

  createosExtension(pi as never);

  return {
    execCalls,
    registeredFlags,
    registeredTools,
    runUserBash(): unknown {
      assert(userBash);
      return userBash();
    },
    async runCommand(name: string, args: string, ctx: never): Promise<void> {
      const command = registeredCommands.get(name);
      assert(command);
      await command.handler(args, ctx);
    },
    async start(): Promise<void> {
      assert(sessionStart);
      await sessionStart(
        { reason: "startup" } as never,
        { mode: "print", ui: { notify() {} } } as never,
      );
    },
  };
}

test("uses --inside-createos-sandbox as the only remote-mode flag", async () => {
  const local = createExtensionHarness();
  assert(local.registeredFlags.includes("inside-createos-sandbox"));
  assert(!local.registeredFlags.includes("createos"));
  assert(local.registeredTools.some((tool) => tool.name === "sandbox_create"));
  assert.equal(local.runUserBash(), undefined);
  await local.start();
  assert.deepEqual(local.execCalls, []);

  const legacy = createExtensionHarness({ createos: true });
  assert.equal(legacy.runUserBash(), undefined);
  await legacy.start();
  assert.deepEqual(legacy.execCalls, []);

  const remote = createExtensionHarness({ "inside-createos-sandbox": true });
  assert.deepEqual(remote.runUserBash(), {
    result: {
      output: "CreateOS sandbox is unavailable — the command was NOT run on your host. Restart Pi.",
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  });
  await remote.start();
  assert.deepEqual(remote.execCalls, [
    { command: "createos", args: ["version"] },
    { command: "createos", args: ["-o", "json", "sandbox", "shapes"] },
  ]);
});

test("allows global network commands without an active sandbox", async () => {
  const extension = createExtensionHarness();
  const notifications: string[] = [];
  const ctx = { ui: { notify: (message: string) => notifications.push(message) } } as never;

  await extension.runCommand("network", "ls", ctx);
  assert.deepEqual(extension.execCalls, [
    { command: "createos", args: ["-o", "json", "sandbox", "network", "ls"] },
  ]);
  assert.deepEqual(notifications, ["No networks. Create with /network create <name>"]);

  await extension.runCommand("network", "attach network-1", ctx);
  assert.equal(notifications.at(-1), "No sandbox active. Launch with --inside-createos-sandbox.");
  assert.equal(extension.execCalls.length, 1);
});

describe("selectStartupSync", () => {
  test("selects one-time sync", () => {
    assert.equal(selectStartupSync(true, false), "once");
  });

  test("selects watcher sync", () => {
    assert.equal(selectStartupSync(false, true), "watch");
  });

  test("does nothing without a flag", () => {
    assert.equal(selectStartupSync(false, false), undefined);
  });

  test("rejects incompatible CreateOS flags", () => {
    assert.throws(
      () => selectStartupSync(true, true),
      /--createos-sync-once and --createos-watch are mutually exclusive/,
    );
  });
});

test("rejects the home directory as a sync source", async () => {
  await assert.rejects(validateLocalSyncSource(process.env.HOME!), /\$HOME itself/);
});

test("archives project files without VCS metadata", () => {
  assert.deepEqual(createArchiveArgs("/host/project", "/tmp/project.tar.gz"), [
    "-C",
    "/host/project",
    "--exclude=.git",
    "--exclude=.hg",
    "--exclude=.svn",
    "-czf",
    "/tmp/project.tar.gz",
    ".",
  ]);
});

test("forwards cancellation to remote commands", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const pi = {
    exec: async (_command: string, _args: string[], options?: { signal?: AbortSignal }) => {
      receivedSignal = options?.signal;
      return { code: 0, stdout: "", stderr: "" };
    },
  };

  await executeInSandbox(pi as never, "sandbox-1", "true", controller.signal);
  assert.equal(receivedSignal, controller.signal);
});

test("quotes archive and destination when extracting", () => {
  assert.equal(
    createExtractCommand("/tmp/a file.tar.gz", "/root/work space"),
    "mkdir -p '/root/work space' && tar -xzf '/tmp/a file.tar.gz' -C '/root/work space' && rm -f '/tmp/a file.tar.gz'",
  );
});

test("rejects the Pi agent directory as a project or skill sync source", async () => {
  const pi = { exec: async () => ({ code: 0, stdout: "", stderr: "" }) };

  await assert.rejects(validateLocalSyncSource(getAgentDir()), /Pi agent directory/);
  await assert.rejects(
    syncSkillDirectories(pi as never, "sandbox-1", [{ baseDir: getAgentDir() }]),
    /skill directory/,
  );
});

test("stages loaded skill directories at their original absolute paths", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-createos-skill-"));
  await writeFile(join(source, "SKILL.md"), "---\nname: test\ndescription: test\n---\n");

  try {
    let archiveArgs: string[] | undefined;
    const pi = {
      exec: async (command: string, args: string[]) => {
        if (command === "tar") archiveArgs = args;
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await syncSkillDirectories(pi as never, "sandbox-1", [
      { baseDir: source },
      { baseDir: source },
    ]);

    assert.deepEqual(archiveArgs?.slice(0, 7), [
      "-C",
      "/",
      "--exclude=.git",
      "--exclude=.hg",
      "--exclude=.svn",
      "-czf",
      archiveArgs?.[6],
    ]);
    assert.equal(archiveArgs?.at(-1), relative("/", source));
    assert.equal(archiveArgs?.filter((arg) => arg === relative("/", source)).length, 1);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test("includes symlink targets for loaded skill directories", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-createos-skill-"));
  const target = join(fixture, "target");
  const intermediate = join(fixture, "intermediate");
  const link = join(fixture, "link");
  await mkdir(target);
  await writeFile(join(target, "SKILL.md"), "---\nname: test\ndescription: test\n---\n");
  await symlink(target, intermediate, "dir");
  await symlink(intermediate, link, "dir");

  try {
    let archiveArgs: string[] | undefined;
    const pi = {
      exec: async (command: string, args: string[]) => {
        if (command === "tar") archiveArgs = args;
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    await syncSkillDirectories(pi as never, "sandbox-1", [{ baseDir: link }]);

    assert(archiveArgs?.includes(relative("/", link)));
    assert(archiveArgs?.includes(relative("/", intermediate)));
    assert(archiveArgs?.includes(relative("/", target)));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("uses Git's unignored file list for a one-time project sync", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-createos-project-"));

  try {
    let checkedForGit = false;
    let archiveFiles: string | undefined;
    const pi = {
      exec: async (command: string, args: string[]) => {
        if (command === "git" && args.includes("rev-parse")) {
          checkedForGit = true;
          return { code: 0, stdout: "true\n", stderr: "" };
        }
        if (command === "git" && args.includes("ls-files")) {
          return { code: 0, stdout: "tracked.ts\0untracked.ts\0", stderr: "" };
        }
        if (command === "tar") {
          const listIndex = args.indexOf("-T");
          if (listIndex >= 0) archiveFiles = await readFile(args[listIndex + 1]!, "utf8");
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    await syncProjectOnce(pi as never, "sandbox-1", source);

    assert.equal(checkedForGit, true);
    assert.equal(archiveFiles, "tracked.ts\0untracked.ts\0");
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test("copies Git-ignored files only when requested", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-createos-project-"));

  try {
    let checkedForGit = false;
    let archiveArgs: string[] | undefined;
    const pi = {
      exec: async (command: string, args: string[]) => {
        if (command === "git") checkedForGit = true;
        if (command === "tar") archiveArgs = args;
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    await syncProjectOnce(pi as never, "sandbox-1", source, { avoidGitIgnore: true });

    assert.equal(checkedForGit, false);
    assert.equal(archiveArgs?.includes("-T"), false);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test("honors .gitignore in a real project archive", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-createos-project-"));
  const source = join(fixture, "source");
  const savedArchive = join(fixture, "project.tar.gz");
  await mkdir(source);
  await writeFile(join(source, ".gitignore"), "ignored.txt\n");
  await writeFile(join(source, "kept.txt"), "kept");
  await writeFile(join(source, "ignored.txt"), "ignored");
  spawnSync("git", ["init", "--quiet", source], { encoding: "utf8" });

  try {
    const pi = {
      exec: async (command: string, args: string[]) => {
        if (command === "createos") return { code: 0, stdout: "", stderr: "" };
        const result = spawnSync(command, args, { encoding: "utf8" });
        if (command === "tar" && result.status === 0) {
          await copyFile(args[args.indexOf("-czf") + 1]!, savedArchive);
        }
        return {
          code: result.status ?? 1,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      },
    };

    await syncProjectOnce(pi as never, "sandbox-1", source);

    const members = spawnSync("tar", ["-tzf", savedArchive], { encoding: "utf8" }).stdout.split(
      "\n",
    );
    assert(members.includes(".gitignore"));
    assert(members.includes("kept.txt"));
    assert(!members.includes("ignored.txt"));
    assert(!members.some((member) => member.startsWith(".git/")));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
