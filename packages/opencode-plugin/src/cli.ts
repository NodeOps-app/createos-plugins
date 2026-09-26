import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { errorText } from "./util.ts";

export interface Result {
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
}
export interface RunOptions {
  signal?: AbortSignal;
  timeout?: number;
  input?: string | Uint8Array;
  cwd?: string;
}
export type Runner = (args: string[], options?: RunOptions) => Promise<Result>;

/** Bound memory while continuing to drain both pipes, including after truncation. */
export function subprocess(
  binary: string,
  args: string[],
  options: RunOptions = {},
): Promise<Result> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    });
    const limit = 2 * 1024 * 1024;
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    let bytes = 0,
      truncated = false,
      failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      const remaining = Math.max(0, limit - bytes);
      chunks.push(chunk.subarray(0, remaining));
      bytes += Math.min(remaining, chunk.length);
      truncated ||= chunk.length > remaining;
    };
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          failure = new Error("Could not terminate CLI process group", { cause: error });
      }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 1000);
    };
    const abort = () =>
      stop(new Error("CreateOS operation cancelled", { cause: options.signal?.reason }));
    const timer =
      options.timeout === 0
        ? undefined
        : setTimeout(() => stop(new Error("CreateOS CLI timed out")), options.timeout ?? 120_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", collect(output));
    child.stderr.on("data", collect(errors));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop(error);
    });
    child.on("error", (error) => {
      failure = new Error(`Cannot run ${binary}: ${error.message}`, { cause: error });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      resolve({
        stdout: Buffer.concat(output).toString(),
        stderr: Buffer.concat(errors).toString(),
        code: code ?? 1,
        truncated,
      });
    });
    child.stdin.end(options.input);
  });
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object from CreateOS");
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value))
    throw new Error("Invalid resource identifier");
  return value;
}
export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function parse(result: Result): unknown {
  if (result.truncated) throw new Error("CreateOS JSON exceeded the output limit");
  try {
    const data: unknown = JSON.parse(result.stdout);
    return data && typeof data === "object" && "data" in data
      ? (data as { data: unknown }).data
      : data;
  } catch (cause) {
    throw new Error("Invalid JSON from CreateOS", { cause });
  }
}
export class CLI {
  constructor(
    readonly run: Runner = (args, options) =>
      subprocess(process.env.CREATEOS_BIN ?? "createos", args, options),
  ) {}
  async checked(args: string[], options?: RunOptions): Promise<Result> {
    const result = await this.run(args, options);
    if (result.code !== 0)
      throw new Error(
        `CreateOS ${args.slice(0, 2).join(" ")} failed: ${result.stderr || result.stdout || result.code}`,
      );
    return result;
  }
  async json(args: string[], options?: RunOptions): Promise<unknown> {
    return parse(await this.checked(["-o", "json", ...args], options));
  }
  async create(
    options: { shape: string; rootfs: string; autoPause: string; network?: string; name?: string },
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    // Allocation is not interrupted or retried: retain the returned ID before observing cancellation.
    const args = [
      "sandbox",
      "create",
      "--shape",
      options.shape,
      "--rootfs",
      options.rootfs,
      "--auto-pause",
      options.autoPause,
    ];
    if (options.network) args.push("--network", options.network);
    if (options.name) args.push("--name", options.name);
    return identifier(record(await this.json(args)).id);
  }
  async destroy(id: string): Promise<void> {
    await this.checked(["sandbox", "rm", "--yes", identifier(id)]);
  }
  async exec(id: string, command: string, signal?: AbortSignal): Promise<Result> {
    return this.run(["sandbox", "exec", identifier(id), "--", "bash", "-lc", command], { signal });
  }
  async script(id: string, command: string, signal?: AbortSignal): Promise<Result> {
    const result = await this.exec(id, command, signal);
    if (result.code !== 0)
      throw new Error(`Sandbox command failed: ${result.stderr || result.stdout}`);
    return result;
  }
  async ready(id: string, signal?: AbortSignal): Promise<void> {
    let resumed = false;
    for (let i = 0; i < 60; i++) {
      const info = record(await this.json(["sandbox", "get", identifier(id)], { signal }));
      if (info.status === "running") return;
      if (info.status === "paused" && !resumed) {
        await this.checked(["sandbox", "resume", id], { signal });
        resumed = true;
      }
      if (info.status === "destroyed" || info.status === "failed")
        throw new Error(`Sandbox ${id} is ${info.status}`);
      await delay(1000, undefined, { signal });
    }
    throw new Error(`Sandbox ${id} did not become ready`);
  }
  async push(id: string, path: string, content: string, signal?: AbortSignal): Promise<void> {
    await this.checked(["sandbox", "push", identifier(id), "-", path], { input: content, signal });
  }
  /** Managed execution survives disconnected output streams; abort explicitly terminates the remote tree. */
  async execute(
    id: string,
    command: string,
    cwd: string,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<Result & { processId: string }> {
    signal?.throwIfAborted();
    const process = record(
      await this.json([
        "sandbox",
        "process",
        "start",
        "--cwd",
        cwd,
        identifier(id),
        "--",
        "bash",
        "-lc",
        command,
      ]),
    );
    const processId = identifier(process.process_id);
    const combined = AbortSignal.any([
      ...(timeout === 0 ? [] : [AbortSignal.timeout(timeout)]),
      ...(signal ? [signal] : []),
    ]);
    try {
      combined.throwIfAborted();
      await this.checked(["sandbox", "process", "close-stdin", id, processId], {
        signal: combined,
      });
      const final = record(
        await this.json(["sandbox", "process", "wait", "--all", id, processId], {
          signal: combined,
          timeout: timeout === 0 ? 0 : timeout + 10_000,
        }),
      );
      if (!Number.isInteger(final.exit_code))
        throw new Error(`Process ${processId} ended without an exit code`);
      const output = await this.checked(
        ["sandbox", "process", "attach", "--no-follow", id, processId],
        { signal: combined },
      );
      const journal =
        final.output && typeof final.output === "object" ? record(final.output) : undefined;
      return {
        ...output,
        truncated:
          output.truncated || (typeof journal?.oldest_seq === "number" && journal.oldest_seq > 1),
        code: final.exit_code as number,
        processId,
      };
    } catch (error) {
      try {
        await this.checked(["sandbox", "process", "stop", "--force", id, processId]);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          `Execution failed; could not stop ${id}/${processId}`,
        );
      }
      throw new Error(`Execution failed in ${id}, process ${processId}: ${errorText(error)}`, {
        cause: error,
      });
    }
  }
}
