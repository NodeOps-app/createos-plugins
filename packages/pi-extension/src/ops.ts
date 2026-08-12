/**
 * CreateOS-backed tool operations via the CLI.
 *
 * Every operation shells out to `createos sandbox exec` or
 * `createos sandbox push/pull` — no HTTP client needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  BashOperations,
  EditOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { sandboxExec, pullFile, pushFile } from "./cli.ts";
import { shellQuote } from "./util.ts";

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

async function run(pi: ExtensionAPI, id: string, command: string) {
  return sandboxExec(pi, id, command);
}

function backgroundSafe(command: string): string {
  return [
    '__pi_out=$(mktemp 2>/dev/null || echo "/tmp/pi-createos-$$.out")',
    `( ${command}`,
    ') >"$__pi_out" 2>&1',
    "__pi_rc=$?",
    'cat "$__pi_out"',
    'rm -f "$__pi_out"',
    "exit $__pi_rc",
  ].join("\n");
}

export function createBashOps(
  pi: ExtensionAPI,
  sandboxId: string,
  cwdOverride?: string,
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal }) => {
      if (signal?.aborted) throw new Error("aborted");
      const effectiveCwd = cwdOverride ?? cwd;
      const fullCmd = effectiveCwd
        ? `cd ${shellQuote(effectiveCwd)} && ${backgroundSafe(command)}`
        : backgroundSafe(command);
      const res = await sandboxExec(pi, sandboxId, fullCmd);
      if (res.stdout) onData(Buffer.from(res.stdout));
      return { exitCode: res.exitCode ?? null };
    },
  };
}

export function createReadOps(pi: ExtensionAPI, sandboxId: string): ReadOperations {
  return {
    readFile: async (path) => Buffer.from(await pullFile(pi, sandboxId, path)),
    access: async (path) => {
      const { exitCode } = await run(pi, sandboxId, `test -r ${shellQuote(path)}`);
      if (exitCode !== 0) throw new Error(`File not readable: ${path}`);
    },
    detectImageMimeType: async (path) => {
      try {
        const { stdout } = await run(pi, sandboxId, `file --mime-type -b ${shellQuote(path)}`);
        const mime = stdout.trim();
        return IMAGE_MIME_TYPES.has(mime) ? mime : null;
      } catch {
        return null;
      }
    },
  };
}

export function createWriteOps(pi: ExtensionAPI, sandboxId: string): WriteOperations {
  return {
    writeFile: (path, content) => pushFile(pi, sandboxId, content, path),
    mkdir: async (dir) => {
      const { exitCode } = await run(pi, sandboxId, `mkdir -p ${shellQuote(dir)}`);
      if (exitCode !== 0) throw new Error(`Failed to create directory: ${dir}`);
    },
  };
}

export function createEditOps(pi: ExtensionAPI, sandboxId: string): EditOperations {
  return {
    readFile: async (path) => Buffer.from(await pullFile(pi, sandboxId, path)),
    writeFile: (path, content) => pushFile(pi, sandboxId, content, path),
    access: async (path) => {
      const { exitCode } = await run(
        pi,
        sandboxId,
        `test -r ${shellQuote(path)} && test -w ${shellQuote(path)}`,
      );
      if (exitCode !== 0) throw new Error(`File not readable/writable: ${path}`);
    },
  };
}

export function createLsOps(pi: ExtensionAPI, sandboxId: string): LsOperations {
  return {
    exists: async (path) => {
      const { exitCode } = await run(pi, sandboxId, `test -e ${shellQuote(path)}`);
      return exitCode === 0;
    },
    stat: async (path) => {
      const q = shellQuote(path);
      const { stdout, exitCode } = await run(
        pi,
        sandboxId,
        `test -e ${q} || exit 1; test -d ${q} && echo dir || echo other`,
      );
      if (exitCode !== 0) throw new Error(`Path not found: ${path}`);
      const isDir = stdout.trim() === "dir";
      return { isDirectory: () => isDir };
    },
    readdir: async (path) => {
      const { stdout, exitCode } = await run(pi, sandboxId, `ls -1A ${shellQuote(path)}`);
      if (exitCode !== 0) throw new Error(`Failed to read directory: ${path}`);
      return stdout.split("\n").filter((line) => line.length > 0);
    },
  };
}
