/**
 * CreateOS provider for the filesystem capability seam. Paths, contents, and
 * atomic staging files stay inside the sandbox owned by `ctx.createos`.
 *
 * CreateOS exposes file *bytes* (`PUT`/`GET /v1/sandboxes/{id}/files`) but no
 * metadata API, so identity, type, size, and freshness come from `stat`,
 * `realpath`, and `find` run through the exec endpoint. Every such call binds
 * caller data to positional parameters, never into the script text.
 * @module @createos/dsh/fs
 */

import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { FileSystem, FsError, FsTargetKey, FsVersion } from "@deepseek-ai/dsh-fs";
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from "@deepseek-ai/dsh-fs";
import { CreateosSandboxNotFoundError, type Sandbox } from "@nodeops-createos/sandbox";
import { execScript, execScriptChecked } from "./exec.ts";

const BINARY_SAMPLE_BYTES = 8192;
const STREAM_CHUNK_BYTES = 64 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** `realpath -m` resolves every component without requiring the target to exist. */
const REALPATH_SCRIPT = `set -e
realpath -mz -- "$1" | base64 | tr -d '\\n'`;

/** Ordered stat facts; `%y` carries nanosecond mtime so same-second rewrites still change the version. */
const STAT_SCRIPT = `stat --printf='%F\\n%s\\n%f\\n%y\\n%i\\n%d\\n' -- "$1"`;

/**
 * One round trip for a whole directory. NUL separators survive newlines in
 * filenames; `%y` is the entry's own type and `%Y` the type it points at, so a
 * symlink is visible without a second call.
 */
const LIST_SCRIPT = `find "$1" -maxdepth 1 -mindepth 1 -printf '%f\\0%y\\0%Y\\0%s\\0%T@\\0%i\\0%D\\0'`;

interface StatFacts {
  kind: string;
  size: number;
  mode: number;
  mtime: string;
  inode: string;
  device: string;
}

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, "FS_ABORTED");
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, 4096);
  const crlf = sample.split("\r\n").length - 1;
  const lf = sample.split("\n").length - 1 - crlf;
  return crlf > lf;
}

function restoreLineEndings(value: string, crlf: boolean): string {
  return crlf ? normalizeLineEndings(value).replaceAll("\n", "\r\n") : value;
}

function decodeText(bytes: Uint8Array, displayPath: string, binarySampleBytes: number): string {
  if (bytes.subarray(0, binarySampleBytes).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, "FS_NOT_TEXT");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, "FS_NOT_TEXT", {
      cause: error,
    });
  }
}

/** Undo the NUL-framed base64 transport `realpath -z` writes. */
function decodeCanonicalPath(encoded: string): string {
  const trimmed = encoded.trim();
  if (trimmed.length === 0 || !BASE64.test(trimmed)) {
    throw new Error("fs-createos: canonical path transport returned invalid base64");
  }
  const framed = Buffer.from(trimmed, "base64");
  if (framed.length < 2 || framed.at(-1) !== 0 || framed.subarray(0, -1).includes(0)) {
    throw new Error("fs-createos: canonical path transport returned invalid NUL framing");
  }
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true }).decode(framed.subarray(0, -1));
  } catch (error: unknown) {
    throw new Error("fs-createos: canonical path is not valid UTF-8", { cause: error });
  }
  if (!posix.isAbsolute(path)) throw new Error("fs-createos: canonical path is not absolute");
  return path;
}

function parseStat(stdout: string): StatFacts | undefined {
  const lines = stdout.split("\n");
  if (lines.length < 6) return undefined;
  const [kind, size, mode, mtime, inode, device] = lines;
  if (kind === undefined || size === undefined || mode === undefined) return undefined;
  if (mtime === undefined || inode === undefined || device === undefined) return undefined;
  return {
    kind,
    size: Number.parseInt(size, 10),
    mode: Number.parseInt(mode, 16),
    mtime,
    inode,
    device,
  };
}

function factsType(kind: string): FsPathInfo["type"] {
  if (kind === "regular file" || kind === "regular empty file") return "file";
  if (kind === "directory") return "directory";
  if (kind === "symbolic link") return "symlink";
  return "other";
}

function versionOf(path: string, facts: StatFacts): FsVersion {
  const material = JSON.stringify([
    path,
    facts.kind,
    facts.size,
    facts.mode,
    facts.mtime,
    facts.inode,
    facts.device,
  ]);
  return FsVersion(`createos:${createHash("sha256").update(material).digest("hex")}`);
}

function mapError(
  error: unknown,
  operation: string,
  displayPath: string,
  signal?: AbortSignal,
): FsError {
  if (error instanceof FsError) return error;
  if (signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError")) {
    return new FsError(`${operation} aborted`, "FS_ABORTED", { cause: error });
  }
  if (error instanceof CreateosSandboxNotFoundError) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, "FS_NOT_FOUND", {
      cause: error,
    });
  }
  const text = String(error);
  if (/no such file or directory/i.test(text)) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, "FS_NOT_FOUND", {
      cause: error,
    });
  }
  if (/permission denied|operation not permitted/i.test(text)) {
    return new FsError(
      `cannot ${operation} "${displayPath}": permission denied`,
      "FS_PERMISSION_DENIED",
      { cause: error },
    );
  }
  return new FsError(`cannot ${operation} "${displayPath}": ${text}`, "FS_IO_ERROR", {
    cause: error,
  });
}

function literalEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldString = normalizeLineEndings(request.oldString);
  const newString = normalizeLineEndings(request.newString);
  if (oldString.length === 0) {
    throw new FsError(
      `cannot edit "${displayPath}": old_string must be non-empty`,
      "FS_EDIT_NOT_FOUND",
    );
  }
  let matches = 0;
  let offset = 0;
  while (true) {
    const found = content.indexOf(oldString, offset);
    if (found < 0) break;
    matches += 1;
    offset = found + oldString.length;
  }
  if (matches === 0)
    throw new FsError(
      `cannot edit "${displayPath}": old_string was not found`,
      "FS_EDIT_NOT_FOUND",
    );
  if (!request.replaceAll && matches !== 1) {
    throw new FsError(
      `cannot edit "${displayPath}": old_string matched ${matches} times`,
      "FS_AMBIGUOUS_EDIT",
    );
  }
  return request.replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);
}

/** Remote filesystem backend sharing the sandbox owned by `ctx.createos`. */
export class CreateosFileSystem extends FileSystem {
  static inject = ["createos"];

  private readonly locks = new Map<string, Promise<unknown>>();

  override async resolve(
    path: string,
    opts?: { cwd?: string; signal?: AbortSignal },
  ): Promise<FsTarget> {
    assertNotAborted(opts?.signal, "resolve");
    if (path.trim().length === 0)
      throw new FsError("file_path must be a non-empty string", "FS_NOT_FOUND");
    const displayPath = posix.resolve(opts?.cwd ?? this.ctx.createos.cwd, path);
    try {
      const sandbox = await this.ctx.createos.getSandbox();
      const targetKey = await this.canonicalPath(sandbox, displayPath, opts?.signal);
      assertNotAborted(opts?.signal, "resolve");
      return { targetKey: FsTargetKey(targetKey), displayPath };
    } catch (error: unknown) {
      throw mapError(error, "resolve", displayPath, opts?.signal);
    }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey);
  }

  override fileUrl(target: FsTarget): string {
    const path = this.processPath(target);
    if (!posix.isAbsolute(path)) {
      throw new Error(`fs-createos: expected an absolute process path: ${JSON.stringify(path)}`);
    }
    return `file://${path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`;
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child));
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative))
    );
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    assertNotAborted(signal, "stat");
    const path = String(target.targetKey);
    const facts = await this.probe(path, target.displayPath, signal);
    if (facts === undefined) return undefined;
    const type = factsType(facts.kind);
    return {
      version: versionOf(path, facts),
      // resolve() already followed every link, so a target can never be a symlink here.
      type: type === "symlink" ? "other" : type,
      ...(type === "file" ? { size: facts.size } : {}),
    };
  }

  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, "lstat");
    if (path.trim().length === 0)
      throw new FsError("file_path must be a non-empty string", "FS_NOT_FOUND");
    const displayPath = posix.resolve(opts?.cwd ?? this.ctx.createos.cwd, path);
    // `stat` does not follow the final component, which is exactly lstat's contract.
    const facts = await this.probe(displayPath, displayPath, signal);
    if (facts === undefined) return undefined;
    const type = factsType(facts.kind);
    return {
      version: versionOf(displayPath, facts),
      type,
      ...(type === "file" ? { size: facts.size } : {}),
    };
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    await this.requireRegular(target, signal);
    const bytes = await this.download(target, signal, "read");
    return decodeText(bytes, target.displayPath, BINARY_SAMPLE_BYTES);
  }

  override async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const info = await this.requireRegular(target, signal);
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(
        `cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`,
        "FS_TOO_LARGE",
      );
    }
    const bytes = await this.download(target, signal, "read");
    // The stat preflight covers the at-rest case; this re-check catches a file
    // that grew between the stat and the transfer.
    if (bytes.byteLength > maxBytes) {
      throw new FsError(
        `cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`,
        "FS_TOO_LARGE",
      );
    }
    return bytes;
  }

  override async streamText(
    target: FsTarget,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<string>> {
    await this.requireRegular(target, signal);
    // ponytail: the files endpoint returns a whole body, so this buffers the
    // file before chunking it. Swap in a ReadableStream read if CreateOS grows
    // a ranged/streaming file GET.
    const bytes = await this.download(target, signal, "read");
    const displayPath = target.displayPath;
    const text = decodeText(bytes, displayPath, BINARY_SAMPLE_BYTES);
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        for (let offset = 0; offset < text.length; offset += STREAM_CHUNK_BYTES) {
          assertNotAborted(signal, "read");
          yield text.slice(offset, offset + STREAM_CHUNK_BYTES);
        }
      },
    };
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const info = await this.stat(target, signal);
    if (info === undefined)
      throw new FsError(`cannot list "${target.displayPath}": not found`, "FS_NOT_FOUND");
    if (info.type !== "directory") {
      throw new FsError(`cannot list "${target.displayPath}": not a directory`, "FS_NOT_DIRECTORY");
    }
    const parentKey = String(target.targetKey);
    try {
      const sandbox = await this.ctx.createos.getSandbox();
      const stdout = await execScriptChecked(sandbox, LIST_SCRIPT, [parentKey], signal);
      const fields = stdout.split("\0");
      const entries: FsDirEntry[] = [];
      // Six fields per entry; a trailing empty element follows the final NUL.
      for (let index = 0; index + 5 < fields.length; index += 6) {
        const [name, ownType, linkType, size, mtime, inode] = fields.slice(index, index + 6) as [
          string,
          string,
          string,
          string,
          string,
          string,
        ];
        if (name === "") continue;
        const displayPath = posix.join(target.displayPath, name);
        const isLink = ownType === "l";
        const childKey = isLink
          ? await this.canonicalPath(sandbox, posix.join(parentKey, name), signal)
          : posix.join(parentKey, name);
        const resolvedType = isLink ? linkType : ownType;
        const type =
          resolvedType === "f"
            ? ("file" as const)
            : resolvedType === "d"
              ? ("directory" as const)
              : ("other" as const);
        entries.push({
          name,
          type,
          target: { targetKey: FsTargetKey(childKey), displayPath },
          version: FsVersion(
            `createos:${createHash("sha256")
              .update(JSON.stringify([childKey, resolvedType, size, mtime, inode]))
              .digest("hex")}`,
          ),
          ...(type === "file" ? { size: Number.parseInt(size, 10) } : {}),
        });
      }
      return entries.sort((left, right) => left.name.localeCompare(right.name));
    } catch (error: unknown) {
      throw mapError(error, "list", target.displayPath, signal);
    }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const path = String(target.targetKey);
      const existing = await this.probe(path, target.displayPath, signal);
      if (existing !== undefined && factsType(existing.kind) !== "file") {
        throw new FsError(
          `cannot write "${target.displayPath}": not a regular file`,
          "FS_NOT_REGULAR_FILE",
        );
      }
      this.checkWriteIntent(path, existing, expected, target);
      const before = existing === undefined ? null : await this.readForDiff(target, signal);
      const version = await this.writeAtomic(
        target,
        content,
        existing,
        expected?.kind === "createIfAbsent",
        signal,
      );
      return {
        operation: existing === undefined ? "create" : "update",
        version,
        before,
        after: normalizeLineEndings(content),
      };
    });
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const path = String(target.targetKey);
      const existing = await this.probe(path, target.displayPath, signal);
      if (existing === undefined) {
        throw new FsError(
          `cannot edit "${target.displayPath}": file changed since it was read`,
          "FS_STALE_VERSION",
        );
      }
      if (factsType(existing.kind) !== "file") {
        throw new FsError(
          `cannot edit "${target.displayPath}": not a regular file`,
          "FS_NOT_REGULAR_FILE",
        );
      }
      if (expected !== undefined && versionOf(path, existing) !== expected.version) {
        throw new FsError(
          `cannot edit "${target.displayPath}": file changed since it was read`,
          "FS_STALE_VERSION",
        );
      }
      const bytes = await this.download(target, signal, "edit");
      const raw = decodeText(bytes, target.displayPath, bytes.length);
      const before = normalizeLineEndings(raw);
      const after = literalEdit(before, edit, target.displayPath);
      const storage = restoreLineEndings(after, detectsCrlf(raw));
      const version = await this.writeAtomic(target, storage, existing, false, signal);
      return { version, before, after };
    });
  }

  /** Serialize mutations per target so read-modify-write pairs cannot interleave. */
  private async withLock<T>(targetKey: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve();
    const run = prior.then(operation, operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(targetKey, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey);
    }
  }

  private async canonicalPath(
    sandbox: Sandbox,
    path: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return decodeCanonicalPath(await execScriptChecked(sandbox, REALPATH_SCRIPT, [path], signal));
  }

  private async probe(
    path: string,
    displayPath: string,
    signal?: AbortSignal,
  ): Promise<StatFacts | undefined> {
    assertNotAborted(signal, "stat");
    try {
      const sandbox = await this.ctx.createos.getSandbox();
      const capture = await execScript(sandbox, STAT_SCRIPT, [path], signal);
      assertNotAborted(signal, "stat");
      if (capture.exitCode !== 0) {
        if (/no such file or directory/i.test(capture.stderr)) return undefined;
        if (/permission denied/i.test(capture.stderr)) {
          throw new FsError(
            `cannot stat "${displayPath}": permission denied`,
            "FS_PERMISSION_DENIED",
          );
        }
        return undefined;
      }
      return parseStat(capture.stdout);
    } catch (error: unknown) {
      throw mapError(error, "stat", displayPath, signal);
    }
  }

  private async requireRegular(target: FsTarget, signal?: AbortSignal): Promise<FsInfo> {
    const info = await this.stat(target, signal);
    if (info === undefined)
      throw new FsError(`cannot read "${target.displayPath}": not found`, "FS_NOT_FOUND");
    if (info.type !== "file") {
      throw new FsError(
        `cannot read "${target.displayPath}": not a regular file`,
        "FS_NOT_REGULAR_FILE",
      );
    }
    return info;
  }

  private async download(
    target: FsTarget,
    signal: AbortSignal | undefined,
    operation: string,
  ): Promise<Uint8Array> {
    try {
      const sandbox = await this.ctx.createos.getSandbox();
      const buffer = await sandbox.files.download(
        String(target.targetKey),
        signal === undefined ? {} : { signal },
      );
      assertNotAborted(signal, operation);
      return new Uint8Array(buffer);
    } catch (error: unknown) {
      throw mapError(error, operation, target.displayPath, signal);
    }
  }

  private checkWriteIntent(
    path: string,
    existing: StatFacts | undefined,
    expected: FsWriteIntent | undefined,
    target: FsTarget,
  ): void {
    if (expected?.kind === "createIfAbsent" && existing !== undefined) {
      throw new FsError(
        `cannot overwrite existing "${target.displayPath}" without reading it first`,
        "FS_NOT_OBSERVED",
      );
    }
    if (expected?.kind === "replaceIfVersion") {
      if (existing === undefined || versionOf(path, existing) !== expected.version) {
        throw new FsError(
          `cannot write "${target.displayPath}": file changed since it was read`,
          "FS_STALE_VERSION",
        );
      }
    }
  }

  private async readForDiff(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      const bytes = await this.download(target, signal, "read");
      return normalizeLineEndings(decodeText(bytes, target.displayPath, bytes.length));
    } catch (error: unknown) {
      // A binary predecessor has no textual diff basis; the write itself stands.
      if (error instanceof FsError && error.code === "FS_NOT_TEXT") return null;
      throw error;
    }
  }

  /**
   * Publish content by renaming a sibling staging file over the target, so a
   * reader never observes a half-written file. Staging lives in the target's own
   * directory to guarantee the rename stays within one filesystem.
   */
  private async writeAtomic(
    target: FsTarget,
    content: string,
    existing: StatFacts | undefined,
    createIfAbsent: boolean,
    signal?: AbortSignal,
  ): Promise<FsVersion> {
    assertNotAborted(signal, "write");
    const sandbox = await this.ctx.createos.getSandbox();
    const targetPath = String(target.targetKey);
    const staging = posix.join(posix.dirname(targetPath), `.dsh-createos-${randomUUID()}.tmp`);
    const mode = (existing === undefined ? 0o600 : existing.mode & 0o777).toString(8);
    try {
      await sandbox.files.upload(staging, content, signal === undefined ? {} : { signal });
      assertNotAborted(signal, "write");
      await execScriptChecked(sandbox, 'chmod "$2" -- "$1"', [staging, mode], signal);
      assertNotAborted(signal, "write");

      if (createIfAbsent) {
        // `ln` fails when the target exists, which makes the create-guard a
        // single atomic step rather than a check followed by a racy write.
        const publication = await execScript(
          sandbox,
          `if ln -T -- "$1" "$2" 2>/dev/null; then printf created
elif [ -e "$2" ] || [ -L "$2" ]; then printf exists
else exit 1
fi`,
          [staging, targetPath],
        );
        if (publication.exitCode !== 0)
          throw new Error(publication.stderr.trim() || "guarded create failed");
        if (publication.stdout === "exists") {
          throw new FsError(
            `cannot overwrite existing "${target.displayPath}" without reading it first`,
            "FS_NOT_OBSERVED",
          );
        }
      } else {
        await execScriptChecked(sandbox, 'mv -f -- "$1" "$2"', [staging, targetPath]);
      }

      const committed = await this.probe(targetPath, target.displayPath, undefined);
      if (committed === undefined)
        throw new Error("published file disappeared before it could be versioned");
      return versionOf(targetPath, committed);
    } catch (error: unknown) {
      throw mapError(error, "write", target.displayPath, signal);
    } finally {
      // The staging file is already gone on the success paths; this only clears
      // it when publication failed partway.
      try {
        await execScript(sandbox, 'rm -f -- "$1"', [staging]);
      } catch {
        // A leftover dotfile in the target directory cannot turn a committed
        // write into a failure.
      }
    }
  }
}

export default CreateosFileSystem;
