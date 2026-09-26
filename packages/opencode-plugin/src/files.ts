import { readFile } from "node:fs/promises";
import { posix, relative, isAbsolute } from "node:path";
import { CLI, quote, parse, record } from "./cli.ts";
import type { Sandbox } from "./runtime.ts";

/** Map host-project absolute paths to the guest; unrelated absolute paths are already guest paths. */
let guestScript: Promise<string> | undefined;

export function remotePath(path: string, box: Sandbox): string {
  if (isAbsolute(path)) {
    const delta = relative(box.source, path);
    if (delta === "" || (!delta.startsWith("../") && delta !== ".."))
      return posix.join(box.cwd, delta);
    return path;
  }
  return posix.resolve(box.cwd, path);
}
export class Files {
  private locks = new Map<string, Promise<unknown>>();
  constructor(private cli: CLI) {}
  async execute(
    box: Sandbox,
    op: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // Serialize file operations per box so edit's read/replace cannot race another tool edit.
    const previous = this.locks.get(box.id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.run(box, op, args, signal));
    this.locks.set(box.id, task);
    try {
      return await task;
    } finally {
      if (this.locks.get(box.id) === task) this.locks.delete(box.id);
    }
  }
  private async run(
    box: Sandbox,
    op: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const args = { ...input };
    for (const key of ["path", "filePath"])
      if (typeof args[key] === "string") args[key] = remotePath(args[key], box);
    if (typeof args.patchText === "string") {
      args.patchText = args.patchText.replace(
        /^(\*\*\* (?:Add File|Update File|Delete File|Move to): )(.+)$/gm,
        (_, prefix, path) => prefix + remotePath(path, box),
      );
    }
    const request = JSON.stringify({ op, args, cwd: box.cwd });
    if (Buffer.byteLength(request) > 2 * 1024 * 1024)
      throw new Error("File operation exceeds 2 MiB");
    const root = `/tmp/opencode-createos-${crypto.randomUUID()}`;
    await this.cli.script(box.id, `mkdir -m 700 ${quote(root)}`, signal);
    try {
      guestScript ??= readFile(new URL("./guest.py", import.meta.url), "utf8");
      await Promise.all([
        guestScript.then((script) => this.cli.push(box.id, root + "/guest.py", script, signal)),
        this.cli.push(box.id, root + "/input.json", request, signal),
      ]);
      const result = await this.cli.execute(
        box.id,
        `python3 ${quote(root + "/guest.py")} < ${quote(root + "/input.json")}`,
        box.cwd,
        120_000,
        signal,
      );
      const data = record(parse(result));
      if (result.code !== 0 || data.error) throw new Error(String(data.error ?? result.stderr));
      return data.result;
    } finally {
      await this.cli.script(box.id, `rm -rf -- ${quote(root)}`);
    }
  }
}
