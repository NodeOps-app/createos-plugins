/** PTY-backed terminal handle over CreateOS managed processes. */

import { Buffer } from "node:buffer";
import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import type {
  CreateOSProcessDetails,
  CreateOSProcesses,
  CreateOSSandbox,
} from "@nodeops-createos/dsh-createos/createos";
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import { decodeOutput } from "./output.ts";
import { assertProcessEvent, processOutcome, startGate } from "./shared.ts";

/** One CreateOS PTY resource with serialized control operations. */
export class CreateOSTerminalHandle implements SubprocessTerminalHandle {
  /** @inheritdoc */
  readonly pid: number;
  /** @inheritdoc */
  readonly output: Readable;
  /** @inheritdoc */
  readonly done: Promise<SubprocessOutcome>;

  private readonly stream = new PassThrough();
  private readonly completion = Promise.withResolvers<SubprocessOutcome>();
  private readonly operations = new AbortController();
  private writeTail: Promise<void> = Promise.resolve();
  private termination: Promise<void> | undefined;

  private constructor(
    private readonly sandbox: CreateOSSandbox,
    private readonly processes: CreateOSProcesses,
    private readonly process: CreateOSProcessDetails,
    private readonly graceMs: number,
  ) {
    this.pid = process.pid;
    this.output = this.stream;
    this.done = this.completion.promise;
  }

  /** Allocate, attach, and release the private start gate before publication. */
  static async create(
    sandbox: CreateOSSandbox,
    processes: CreateOSProcesses,
    remoteEnvironment: string,
    spec: SubprocessTerminalSpawnSpec,
    environmentArgs: (raw: string, explicit: Readonly<NodeJS.ProcessEnv> | undefined) => string[],
  ): Promise<CreateOSTerminalHandle> {
    const program = spec.argv[0];
    if (program === undefined || program.length === 0)
      throw new Error("subprocess-createos: terminal argv requires a program");
    const gate = startGate(true);
    const process = await processes.create(
      {
        cmd: "/bin/sh",
        args: [
          "-c",
          gate.script,
          "dsh-createos-terminal",
          gate.marker,
          gate.token,
          ...environmentArgs(remoteEnvironment, spec.env),
          program,
          ...spec.argv.slice(1),
        ],
        cwd: spec.cwd,
        pty: { rows: spec.rows, cols: spec.cols },
      },
      spec.signal,
    );
    const handle = new CreateOSTerminalHandle(sandbox, processes, process, spec.graceMs);
    try {
      await handle.attach(gate.marker, gate.token, spec.signal);
      return handle;
    } catch (error: unknown) {
      await processes.terminate(process.process_id, spec.graceMs).catch(() => {});
      throw error;
    }
  }

  /** @inheritdoc */
  write(data: string): Promise<void> {
    if (this.termination !== undefined)
      return Promise.reject(new Error("subprocess-createos: terminal is terminating"));
    const write = this.writeTail.then(async () => {
      await this.processes.input(
        this.process.process_id,
        Buffer.from(data),
        this.operations.signal,
      );
    });
    this.writeTail = write.catch(() => {});
    return write;
  }

  /** @inheritdoc */
  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    if (this.termination !== undefined) return undefined;
    const result = await this.sandbox.runCommand(
      "/bin/ps",
      ["-o", "tpgid=", "-p", String(this.pid)],
      {
        retry: false,
        signal: this.operations.signal,
      },
    );
    if (result.result.exit_code !== 0) return undefined;
    const processGroupId = Number(result.result.stdout.trim());
    if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) return undefined;
    return { processGroupId, inputWaiting: false };
  }

  /** @inheritdoc */
  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    const foreground = await this.inspectForeground();
    if (foreground === undefined)
      throw new Error(`subprocess-createos: cannot resolve foreground group for ${this.pid}`);
    if (signal === "SIGKILL" && foreground.processGroupId === this.pid) {
      throw new Error(
        "refusing to SIGKILL the terminal shell; terminate the terminal session instead",
      );
    }
    if (signal !== "SIGTSTP") {
      await this.processes.signal(this.process.process_id, signal, this.operations.signal);
      return foreground.processGroupId;
    }
    const result = await this.sandbox.runCommand(
      "/bin/kill",
      [`-${signal.slice(3)}`, "--", `-${foreground.processGroupId}`],
      { retry: false, signal: this.operations.signal },
    );
    if (result.result.exit_code !== 0) {
      throw new Error(`subprocess-createos: foreground signal failed: ${result.result.stderr}`);
    }
    return foreground.processGroupId;
  }

  /** @inheritdoc */
  terminate(): Promise<void> {
    this.termination ??= this.terminateRemote();
    return this.termination;
  }

  private async attach(marker: string, token: string, signal?: AbortSignal): Promise<void> {
    const setupSignal =
      signal === undefined
        ? this.operations.signal
        : AbortSignal.any([signal, this.operations.signal]);
    const iterator = this.processes.connect(this.process.process_id, 0, setupSignal);
    let markerPending = Buffer.from(marker);
    for (;;) {
      signal?.throwIfAborted();
      const next = await iterator.next();
      if (next.done) throw new Error("subprocess-createos: terminal output ended during setup");
      const event = next.value;
      assertProcessEvent(event);
      if (event.type === "exit")
        throw new Error("subprocess-createos: terminal exited during setup");
      if (event.type !== "data") continue;
      const bytes = decodeOutput(event.data_base64);
      const matched = Math.min(markerPending.length, bytes.length);
      if (!bytes.subarray(0, matched).equals(markerPending.subarray(0, matched))) {
        throw new Error("subprocess-createos: terminal start marker was not first output");
      }
      markerPending = markerPending.subarray(matched);
      const remaining = bytes.subarray(matched);
      if (markerPending.length > 0) continue;
      await this.processes.input(this.process.process_id, Buffer.from(`${token}\n`), setupSignal);
      if (remaining.length > 0) this.stream.write(remaining);
      void this.pump(iterator);
      return;
    }
  }

  private async pump(
    iterator: AsyncGenerator<
      import("@nodeops-createos/dsh-createos/createos").CreateOSProcessEvent
    >,
  ): Promise<void> {
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new Error("subprocess-createos: terminal output ended without exit");
        const event = next.value;
        assertProcessEvent(event);
        if (event.type === "exit") {
          this.stream.end();
          this.completion.resolve(
            processOutcome({ exit_code: event.exit_code ?? null, signal: event.signal }),
          );
          return;
        }
        if (event.type === "data") {
          if (event.stream !== "pty")
            throw new Error("subprocess-createos: PTY emitted a pipe stream");
          this.stream.write(decodeOutput(event.data_base64));
        }
      }
    } catch (error: unknown) {
      if (this.termination !== undefined) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.stream.destroy(failure);
      this.completion.reject(failure);
    }
  }

  private async terminateRemote(): Promise<void> {
    this.operations.abort(new Error("subprocess-createos: terminal is terminating"));
    await this.writeTail;
    const details = await this.processes.terminate(this.process.process_id, this.graceMs);
    this.stream.end();
    this.completion.resolve(processOutcome(details));
  }
}
