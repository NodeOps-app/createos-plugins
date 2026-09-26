import { mkdtemp, rm, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { CLI, subprocess, quote } from "./cli.ts";

/** A one-way snapshot. Remote-only files survive; nothing is copied back implicitly. */
export async function stage(
  cli: CLI,
  id: string,
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  source = await realpath(source);
  if (source === "/" || source === homedir() || !(await stat(source)).isDirectory())
    throw new Error("Sync source must be a project directory");
  const dir = await mkdtemp(join(tmpdir(), "createos-stage-"));
  const archive = join(dir, "project.tar.gz");
  const remote = `/tmp/createos-${crypto.randomUUID()}.tar.gz`;
  try {
    const git = await subprocess("git", ["-C", source, "rev-parse", "--is-inside-work-tree"], {
      signal,
    });
    const args = [
      "-C",
      source,
      "--exclude=.git",
      "--exclude=.hg",
      "--exclude=.svn",
      "--exclude=node_modules",
      "--exclude=.venv",
      "--exclude=.env",
      "--exclude=.env.*",
      "--exclude=.ssh",
      "--exclude=.aws",
      "--exclude=.createos",
      "--exclude=.opencode",
      "--exclude=*.pem",
      "--exclude=*.key",
    ];
    if (git.code === 0) {
      const files = await subprocess(
        "git",
        ["-C", source, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { signal },
      );
      if (files.code !== 0 || files.truncated)
        throw new Error("Could not enumerate complete project file list");
      const names = files.stdout.split("\0").filter(Boolean);
      for (const name of names) {
        const delta = relative(source, join(source, name));
        if (isAbsolute(name) || delta.startsWith("../"))
          throw new Error("Project file escaped source directory");
      }
      await writeFile(join(dir, "files"), names.join("\0") + (names.length ? "\0" : ""));
      args.push("--no-recursion", "--null", "-T", join(dir, "files"));
    } else args.push(".");
    // Options precede the source for portable BSD/GNU tar behavior.
    const packed = await subprocess("tar", ["-czf", archive, ...args], {
      signal,
      timeout: 600_000,
    });
    if (packed.code !== 0) throw new Error(`Project archive failed: ${packed.stderr}`);
    await cli.checked(["sandbox", "push", id, archive, remote], { signal, timeout: 600_000 });
    await cli.script(
      id,
      `mkdir -p ${quote(destination)} && tar -xzf ${quote(remote)} -C ${quote(destination)} && rm -f ${quote(remote)}`,
      signal,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
