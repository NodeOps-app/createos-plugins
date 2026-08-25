/** CreateOS implementation of the filesystem capability seam. */

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
  CreateosSandboxNotFoundError,
  type CreateOSSandbox,
} from "@nodeops-createos/dsh-createos/createos";
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

const BINARY_SAMPLE_BYTES = 8192;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

interface RemoteEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
  mode: number;
  modified: string;
}

function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal; retry: false } {
  return { retry: false, ...(signal === undefined ? {} : { signal }) };
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

function decodeText(bytes: Uint8Array, displayPath: string, sampleBytes: number): string {
  if (bytes.subarray(0, sampleBytes).includes(0)) {
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

function decodeBase64(value: string, operation: string): Buffer {
  if (!BASE64.test(value)) throw new Error(`fs-createos: ${operation} returned invalid base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    throw new Error(`fs-createos: ${operation} returned non-canonical base64`);
  return bytes;
}

function decodeNulFields(value: string, operation: string): string[] {
  const bytes = decodeBase64(value.trim(), operation);
  if (bytes.length === 0 || bytes.at(-1) !== 0)
    throw new Error(`fs-createos: ${operation} returned invalid framing`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new Error(`fs-createos: ${operation} returned invalid UTF-8`, { cause: error });
  }
  return text.slice(0, -1).split("\0");
}

function entryVersion(entry: RemoteEntry): ReturnType<typeof FsVersion> {
  return FsVersion(`createos:${createHash("sha256").update(JSON.stringify(entry)).digest("hex")}`);
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
  if (
    error instanceof CreateosSandboxNotFoundError ||
    /not found|no such file/i.test(String(error))
  ) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, "FS_NOT_FOUND", {
      cause: error,
    });
  }
  if (/permission denied|operation not permitted/i.test(String(error))) {
    return new FsError(
      `cannot ${operation} "${displayPath}": permission denied`,
      "FS_PERMISSION_DENIED",
      { cause: error },
    );
  }
  return new FsError(`cannot ${operation} "${displayPath}": ${String(error)}`, "FS_IO_ERROR", {
    cause: error,
  });
}

function literalEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldString = normalizeLineEndings(request.oldString);
  const newString = normalizeLineEndings(request.newString);
  if (oldString.length === 0)
    throw new FsError(
      `cannot edit "${displayPath}": old_string must be non-empty`,
      "FS_EDIT_NOT_FOUND",
    );
  let matches = 0;
  let offset = 0;
  for (;;) {
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
export class CreateOSFileSystem extends FileSystem {
  static inject = ["createos"];

  private readonly locks = new Map<string, Promise<unknown>>();

  /** @inheritdoc */
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
      const result = await sandbox.runCommand(
        "/bin/sh",
        ["-c", 'realpath -mz -- "$1" | base64 -w0', "dsh-createos-realpath", displayPath],
        signalOptions(opts?.signal),
      );
      if (result.result.exit_code !== 0) throw new Error(result.result.stderr || "realpath failed");
      const framed = decodeBase64(result.result.stdout.trim(), "canonical path");
      if (framed.length < 2 || framed.at(-1) !== 0 || framed.subarray(0, -1).includes(0)) {
        throw new Error("fs-createos: canonical path returned invalid framing");
      }
      const canonical = new TextDecoder("utf-8", { fatal: true }).decode(framed.subarray(0, -1));
      if (!posix.isAbsolute(canonical))
        throw new Error("fs-createos: canonical path is not absolute");
      return { targetKey: FsTargetKey(canonical), displayPath };
    } catch (error: unknown) {
      throw mapError(error, "resolve", displayPath, opts?.signal);
    }
  }

  /** @inheritdoc */
  override processPath(target: FsTarget): string {
    return String(target.targetKey);
  }

  /** @inheritdoc */
  override fileUrl(target: FsTarget): string {
    const path = this.processPath(target);
    if (!posix.isAbsolute(path))
      throw new Error(`fs-createos: expected absolute process path: ${path}`);
    return `file://${path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`;
  }

  /** @inheritdoc */
  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child));
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative))
    );
  }

  /** @inheritdoc */
  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const entry = await this.probe(String(target.targetKey), true, target.displayPath, signal);
    if (entry === undefined) return undefined;
    return {
      version: entryVersion(entry),
      type: entry.type === "symlink" ? "other" : entry.type,
      ...(entry.type === "file" ? { size: entry.size } : {}),
    };
  }

  /** @inheritdoc */
  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    if (path.trim().length === 0)
      throw new FsError("file_path must be a non-empty string", "FS_NOT_FOUND");
    const displayPath = posix.resolve(opts?.cwd ?? this.ctx.createos.cwd, path);
    const entry = await this.probe(displayPath, false, displayPath, signal);
    if (entry === undefined) return undefined;
    return {
      version: entryVersion(entry),
      type: entry.type,
      ...(entry.type === "file" ? { size: entry.size } : {}),
    };
  }

  /** @inheritdoc */
  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    await this.requireRegular(target, signal);
    try {
      const sandbox = await this.ctx.createos.getSandbox();
      const bytes = new Uint8Array(
        await sandbox.files.download(String(target.targetKey), signalOptions(signal)),
      );
      assertNotAborted(signal, "read");
      return decodeText(bytes, target.displayPath, BINARY_SAMPLE_BYTES);
    } catch (error: unknown) {
      throw mapError(error, "read", target.displayPath, signal);
    }
  }

  /** @inheritdoc */
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
    const stream = await this.openDownload(target, signal);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let complete = false;
    try {
      for (;;) {
        assertNotAborted(signal, "read");
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) {
          throw new FsError(
            `cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`,
            "FS_TOO_LARGE",
          );
        }
        chunks.push(next.value);
      }
      complete = true;
    } catch (error: unknown) {
      throw mapError(error, "read", target.displayPath, signal);
    } finally {
      if (!complete) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  /** @inheritdoc */
  override async streamText(
    target: FsTarget,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<string>> {
    await this.requireRegular(target, signal);
    const stream = await this.openDownload(target, signal);
    const displayPath = target.displayPath;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        const reader = stream.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let sampled = 0;
        let complete = false;
        try {
          for (;;) {
            assertNotAborted(signal, "read");
            const next = await reader.read();
            if (next.done) break;
            if (sampled < BINARY_SAMPLE_BYTES) {
              const sample = next.value.subarray(0, BINARY_SAMPLE_BYTES - sampled);
              if (sample.includes(0))
                throw new FsError(`cannot read "${displayPath}": binary file`, "FS_NOT_TEXT");
              sampled += sample.byteLength;
            }
            let text: string;
            try {
              text = decoder.decode(next.value, { stream: true });
            } catch (error: unknown) {
              throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, "FS_NOT_TEXT", {
                cause: error,
              });
            }
            if (text.length > 0) yield text;
          }
          decoder.decode();
          complete = true;
        } catch (error: unknown) {
          throw mapError(error, "read", displayPath, signal);
        } finally {
          if (!complete) await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      },
    };
  }

  /** @inheritdoc */
  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const info = await this.stat(target, signal);
    if (info === undefined)
      throw new FsError(`cannot list "${target.displayPath}": not found`, "FS_NOT_FOUND");
    if (info.type !== "directory")
      throw new FsError(`cannot list "${target.displayPath}": not a directory`, "FS_NOT_DIRECTORY");
    try {
      const sandbox = await this.ctx.createos.getSandbox();
      const result = await sandbox.runCommand(
        "/bin/sh",
        [
          "-c",
          "find -P \"$1\" -mindepth 1 -maxdepth 1 -printf '%f\\0%p\\0%y\\0%s\\0%m\\0%T@\\0' | base64 -w0",
          "dsh-createos-list",
          String(target.targetKey),
        ],
        signalOptions(signal),
      );
      if (result.result.exit_code !== 0) throw new Error(result.result.stderr || "find failed");
      if (result.result.stdout.length === 0) return [];
      const fields = decodeNulFields(result.result.stdout, "directory listing");
      if (fields.length % 6 !== 0)
        throw new Error("fs-createos: directory listing returned invalid fields");
      const entries: FsDirEntry[] = [];
      for (let index = 0; index < fields.length; index += 6) {
        const [name, childPath, typeCode, size, mode, modified] = fields.slice(
          index,
          index + 6,
        ) as [string, string, string, string, string, string];
        const displayPath = posix.join(target.displayPath, name);
        const resolved = await this.resolve(childPath, signal === undefined ? {} : { signal });
        const child =
          typeCode === "l"
            ? await this.probe(String(resolved.targetKey), true, displayPath, signal)
            : parseEntry(childPath, typeCode, size, mode, modified);
        entries.push({
          name,
          type: child?.type === "symlink" ? "other" : (child?.type ?? "other"),
          target: { targetKey: resolved.targetKey, displayPath },
          ...(child === undefined ? {} : { version: entryVersion(child) }),
          ...(child?.type === "file" ? { size: child.size } : {}),
        });
      }
      return entries.sort((left, right) => left.name.localeCompare(right.name));
    } catch (error: unknown) {
      throw mapError(error, "list", target.displayPath, signal);
    }
  }

  /** @inheritdoc */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), true, target.displayPath, signal);
      if (existing !== undefined && existing.type !== "file") {
        throw new FsError(
          `cannot write "${target.displayPath}": not a regular file`,
          "FS_NOT_REGULAR_FILE",
        );
      }
      this.checkWriteIntent(existing, expected, target);
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

  /** @inheritdoc */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), true, target.displayPath, signal);
      if (
        existing === undefined ||
        (expected !== undefined && entryVersion(existing) !== expected.version)
      ) {
        throw new FsError(
          `cannot edit "${target.displayPath}": file changed since it was read`,
          "FS_STALE_VERSION",
        );
      }
      if (existing.type !== "file") {
        throw new FsError(
          `cannot edit "${target.displayPath}": not a regular file`,
          "FS_NOT_REGULAR_FILE",
        );
      }
      const raw = await this.readText(target, signal);
      const before = normalizeLineEndings(raw);
      const after = literalEdit(before, edit, target.displayPath);
      const version = await this.writeAtomic(
        target,
        restoreLineEndings(after, detectsCrlf(raw)),
        existing,
        false,
        signal,
      );
      return { version, before, after };
    });
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const run = prior.then(operation, operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private async probe(
    path: string,
    follow: boolean,
    displayPath: string,
    signal?: AbortSignal,
  ): Promise<RemoteEntry | undefined> {
    assertNotAborted(signal, "stat");
    try {
      const sandbox = await this.ctx.createos.getSandbox();
      const result = await sandbox.runCommand(
        "/bin/sh",
        [
          "-c",
          `stat ${follow ? "-L " : ""}--printf='%F\\0%s\\0%a\\0%y\\0' -- "$1" | base64 -w0`,
          "dsh-createos-stat",
          path,
        ],
        signalOptions(signal),
      );
      if (result.result.exit_code !== 0) {
        if (/no such file|not found/i.test(result.result.stderr)) return undefined;
        throw new Error(result.result.stderr || "stat failed");
      }
      const [kind, size, mode, modified] = decodeNulFields(result.result.stdout, "stat") as [
        string,
        string,
        string,
        string,
      ];
      return {
        path,
        type: statType(kind),
        ...(kind === "regular file" ? { size: parseNonnegative(size, "size") } : {}),
        mode: Number.parseInt(mode, 8),
        modified,
      };
    } catch (error: unknown) {
      throw mapError(error, "stat", displayPath, signal);
    }
  }

  private async openDownload(
    target: FsTarget,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const sandbox = await this.ctx.createos.getSandbox();
    const path = `/v1/sandboxes/${encodeURIComponent(sandbox.id)}/files`;
    const response = await this.ctx.createos.getClient().http.requestRaw("GET", path, {
      query: { path: String(target.targetKey) },
      ...signalOptions(signal),
    });
    if (!response.ok)
      await this.ctx.createos.getClient().http.throwForResponse(response, "GET", path);
    if (response.body === null) throw new Error("fs-createos: download returned no response body");
    return response.body;
  }

  private async requireRegular(target: FsTarget, signal?: AbortSignal): Promise<FsInfo> {
    const info = await this.stat(target, signal);
    if (info === undefined)
      throw new FsError(`cannot read "${target.displayPath}": not found`, "FS_NOT_FOUND");
    if (info.type !== "file")
      throw new FsError(
        `cannot read "${target.displayPath}": not a regular file`,
        "FS_NOT_REGULAR_FILE",
      );
    return info;
  }

  private checkWriteIntent(
    existing: RemoteEntry | undefined,
    expected: FsWriteIntent | undefined,
    target: FsTarget,
  ): void {
    if (expected?.kind === "createIfAbsent" && existing !== undefined) {
      throw new FsError(
        `cannot overwrite existing "${target.displayPath}" without reading it first`,
        "FS_NOT_OBSERVED",
      );
    }
    if (
      expected?.kind === "replaceIfVersion" &&
      (existing === undefined || entryVersion(existing) !== expected.version)
    ) {
      throw new FsError(
        `cannot write "${target.displayPath}": file changed since it was read`,
        "FS_STALE_VERSION",
      );
    }
  }

  private async readForDiff(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      return normalizeLineEndings(await this.readText(target, signal));
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === "FS_NOT_TEXT") return null;
      throw error;
    }
  }

  private async writeAtomic(
    target: FsTarget,
    content: string,
    existing: RemoteEntry | undefined,
    createIfAbsent: boolean,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof FsVersion>> {
    assertNotAborted(signal, "write");
    const sandbox = await this.ctx.createos.getSandbox();
    const targetPath = String(target.targetKey);
    const staging = posix.join(posix.dirname(targetPath), `.dsh-createos-${randomUUID()}.tmp`);
    const temporary = posix.join(staging, "content");
    let created = false;
    try {
      await this.runChecked(sandbox, "/bin/mkdir", ["-p", "--", posix.dirname(targetPath)], signal);
      await this.runChecked(sandbox, "/bin/mkdir", ["-m", "700", "--", staging], signal);
      created = true;
      await sandbox.files.upload(temporary, content, signalOptions(signal));
      await this.runChecked(
        sandbox,
        "/bin/chmod",
        [(existing?.mode ?? 0o600).toString(8), "--", temporary],
        signal,
      );
      assertNotAborted(signal, "write");
      if (createIfAbsent) {
        const publication = await sandbox.runCommand(
          "/bin/ln",
          ["-T", "--", temporary, targetPath],
          signalOptions(undefined),
        );
        if (publication.result.exit_code !== 0) {
          const current = await this.probe(targetPath, false, target.displayPath);
          if (current !== undefined) {
            throw new FsError(
              `cannot overwrite existing "${target.displayPath}" without reading it first`,
              "FS_NOT_OBSERVED",
            );
          }
          throw new Error(publication.result.stderr || "guarded publication failed");
        }
      } else {
        await this.runChecked(sandbox, "/bin/mv", ["-f", "-T", "--", temporary, targetPath]);
      }
      const committed = await this.probe(targetPath, true, target.displayPath);
      if (committed === undefined) throw new Error("fs-createos: committed file disappeared");
      await this.runChecked(sandbox, "/bin/rmdir", ["--", staging]).catch(() => {});
      return entryVersion(committed);
    } catch (error: unknown) {
      if (created)
        await this.runChecked(sandbox, "/bin/rm", ["-rf", "--", staging]).catch(() => {});
      throw mapError(error, "write", target.displayPath, signal);
    }
  }

  private async runChecked(
    sandbox: CreateOSSandbox,
    command: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await sandbox.runCommand(command, args, signalOptions(signal));
    if (result.result.exit_code !== 0) throw new Error(result.result.stderr || `${command} failed`);
  }
}

function statType(kind: string): RemoteEntry["type"] {
  if (kind === "regular file") return "file";
  if (kind === "directory") return "directory";
  if (kind === "symbolic link") return "symlink";
  return "other";
}

function parseEntry(
  path: string,
  typeCode: string,
  size: string,
  mode: string,
  modified: string,
): RemoteEntry {
  const type =
    typeCode === "f"
      ? "file"
      : typeCode === "d"
        ? "directory"
        : typeCode === "l"
          ? "symlink"
          : "other";
  return {
    path,
    type,
    ...(type === "file" ? { size: parseNonnegative(size, "size") } : {}),
    mode: Number.parseInt(mode, 8),
    modified,
  };
}

function parseNonnegative(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`fs-createos: invalid ${label}`);
  return parsed;
}

export default CreateOSFileSystem;
