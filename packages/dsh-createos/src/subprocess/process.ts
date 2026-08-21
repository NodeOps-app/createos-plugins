/** Ordinary managed-process handle over CreateOS output journals. */

import { Buffer } from "node:buffer";
import { PassThrough, Writable } from "node:stream";
import type { Readable } from "node:stream";
import type { CreateOSProcessDetails } from "@nodeops-createos/dsh-createos/createos";
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutputMode,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import { CreateOSOutputReader, decodeOutput } from "./output.ts";
import { assertProcessEvent, processOutcome, startGate, waitScope } from "./shared.ts";
import type { CreateOSProcessOperations } from "./shared.ts";

interface OutputSink {
  stream?: PassThrough;
  collected?: CreateOSOutputReader;
  inherit?: NodeJS.WriteStream;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** One asynchronously allocated CreateOS process published through the synchronous subprocess seam. */
export class CreateOSSubprocessHandle implements SubprocessHandle {
  private process: CreateOSProcessDetails | undefined;
  private readonly stdoutSink: OutputSink;
  private readonly stderrSink: OutputSink;
  private readonly completion = Promise.withResolvers<SubprocessOutcome>();
  private readonly gateReady = Promise.withResolvers<void>();
  private readonly startAbort = new AbortController();
  private termination: Promise<void> | undefined;
  private ended = false;

  /** @inheritdoc */
  get pid(): number {
    return this.process?.pid ?? -1;
  }
  /** @inheritdoc */
  readonly stdin: Writable | undefined;
  /** @inheritdoc */
  readonly stdout: Readable | undefined;
  /** @inheritdoc */
  readonly stderr: Readable | undefined;
  /** @inheritdoc */
  readonly collected: SubprocessCollectedOutputs;
  /** @inheritdoc */
  readonly done = this.completion.promise;

  constructor(
    private readonly processes: CreateOSProcessOperations,
    private readonly remoteEnvironment: Promise<string>,
    private readonly spec: SubprocessSpawnSpec,
    environmentArgs: (raw: string, explicit: Readonly<NodeJS.ProcessEnv> | undefined) => string[],
  ) {
    this.stdoutSink = outputSink(spec.stdio.stdout, process.stdout);
    this.stderrSink = outputSink(spec.stdio.stderr, process.stderr);
    this.stdout = this.stdoutSink.stream;
    this.stderr = this.stderrSink.stream;
    this.collected = {
      ...(this.stdoutSink.collected === undefined ? {} : { stdout: this.stdoutSink.collected }),
      ...(this.stderrSink.collected === undefined ? {} : { stderr: this.stderrSink.collected }),
    };
    this.stdin =
      spec.stdio.stdin === "pipe"
        ? new Writable({
            write: (chunk: Buffer | string, _encoding, callback) => {
              void this.writeInput(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).then(
                () => {
                  callback();
                },
                (error: unknown) => {
                  callback(asError(error));
                },
              );
            },
            final: (callback) => {
              void this.closeInput().then(
                () => {
                  callback();
                },
                (error: unknown) => {
                  callback(asError(error));
                },
              );
            },
          })
        : undefined;
    void this.start(environmentArgs);
    const onAbort = (): void => {
      this.terminate();
    };
    spec.signal?.addEventListener("abort", onAbort, { once: true });
    void this.done
      .finally(() => spec.signal?.removeEventListener("abort", onAbort))
      .catch(() => {});
  }

  /** @inheritdoc */
  terminate(): void {
    this.termination ??= this.terminateRemote();
    void this.termination.catch((error: unknown) => {
      this.fail(error);
    });
  }

  /** @inheritdoc */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    let process = this.process;
    if (process === undefined) {
      await Promise.race([
        this.done.catch(() => undefined),
        ...(signal === undefined
          ? []
          : [
              new Promise<void>((resolve) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    resolve();
                  },
                  { once: true },
                );
              }),
            ]),
      ]);
      process = this.process;
    }
    if (process === undefined || signal?.aborted === true) return false;
    return (await waitScope(this.processes, process.process_id, "tree", signal)) !== undefined;
  }

  private async start(
    environmentArgs: (raw: string, explicit: Readonly<NodeJS.ProcessEnv> | undefined) => string[],
  ): Promise<void> {
    try {
      const program = this.spec.argv[0];
      if (program === undefined || program.length === 0)
        throw new Error("invalid argv: expected a program");
      const rawEnvironment = await this.remoteEnvironment;
      const gate = startGate(false);
      const args = environmentArgs(rawEnvironment, this.spec.env);
      this.process = await this.processes.create(
        {
          cmd: "/bin/sh",
          args: [
            "-c",
            gate.script,
            "dsh-createos-runner",
            gate.marker,
            gate.token,
            ...args,
            program,
            ...this.spec.argv.slice(1),
          ],
          cwd: this.spec.cwd,
        },
        this.startAbort.signal,
      );
      const pump = this.pumpOutput(gate.marker, gate.token);
      await Promise.race([
        this.gateReady.promise,
        pump.then(() => {
          throw new Error("subprocess-createos: process exited before its start gate opened");
        }),
      ]);
      await this.initializeStdin();
      const outcome = await pump;
      this.finish(outcome);
    } catch (error: unknown) {
      this.fail(error);
    }
  }

  private async pumpOutput(marker: string, token: string): Promise<SubprocessOutcome> {
    const process = this.process as CreateOSProcessDetails;
    let markerPending = Buffer.from(marker);
    let gateOpened = false;
    for await (const event of this.processes.connect(
      process.process_id,
      0,
      this.startAbort.signal,
    )) {
      assertProcessEvent(event);
      if (event.type === "exit")
        return processOutcome({ exit_code: event.exit_code ?? null, signal: event.signal });
      if (event.type !== "data") continue;
      let bytes = decodeOutput(event.data_base64);
      if (!gateOpened) {
        const matched = Math.min(markerPending.length, bytes.length);
        if (!bytes.subarray(0, matched).equals(markerPending.subarray(0, matched))) {
          throw new Error("subprocess-createos: process start marker was not first output");
        }
        markerPending = markerPending.subarray(matched);
        bytes = bytes.subarray(matched);
        if (markerPending.length === 0) {
          gateOpened = true;
          await this.processes.input(
            process.process_id,
            Buffer.from(`${token}\n`),
            this.startAbort.signal,
          );
          this.gateReady.resolve();
        }
        if (bytes.length === 0) continue;
      }
      this.push(event.stream, bytes);
    }
    throw new Error("subprocess-createos: output stream ended without an exit event");
  }

  private async initializeStdin(): Promise<void> {
    const mode = this.spec.stdio.stdin;
    if (mode === "pipe") return;
    if (typeof mode === "object") await this.writeInput(Buffer.from(mode.data));
    await this.closeInput();
  }

  private async writeInput(data: Uint8Array): Promise<void> {
    const process = await this.requireProcess();
    await this.processes.input(process.process_id, data, this.startAbort.signal);
  }

  private async closeInput(): Promise<void> {
    const process = await this.requireProcess();
    await this.processes.closeStdin(process.process_id, this.startAbort.signal);
  }

  private async requireProcess(): Promise<CreateOSProcessDetails> {
    while (this.process === undefined) {
      if (this.ended) throw new Error("subprocess-createos: process did not start");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return this.process;
  }

  private push(stream: "stdout" | "stderr" | "pty", bytes: Buffer): void {
    if (stream === "pty")
      throw new Error("subprocess-createos: ordinary process emitted PTY output");
    const sink = stream === "stdout" ? this.stdoutSink : this.stderrSink;
    sink.stream?.write(bytes);
    sink.collected?.push(bytes);
    sink.inherit?.write(bytes);
  }

  private async terminateRemote(): Promise<void> {
    const process = await this.requireProcess();
    const ended = await this.processes.terminate(process.process_id, this.spec.graceMs);
    this.startAbort.abort(new Error("subprocess-createos: process terminated"));
    this.finish(processOutcome(ended));
  }

  private finish(outcome: SubprocessOutcome): void {
    if (this.ended) return;
    this.ended = true;
    this.stdoutSink.stream?.end();
    this.stderrSink.stream?.end();
    this.completion.resolve(outcome);
  }

  private fail(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.stdoutSink.stream?.destroy(failure);
    this.stderrSink.stream?.destroy(failure);
    this.completion.reject(failure);
  }
}

function outputSink(mode: SubprocessOutputMode, inherit: NodeJS.WriteStream): OutputSink {
  if (mode === "pipe") return { stream: new PassThrough() };
  if (mode === "inherit") return { inherit };
  return { collected: new CreateOSOutputReader(mode.maxBytes) };
}
