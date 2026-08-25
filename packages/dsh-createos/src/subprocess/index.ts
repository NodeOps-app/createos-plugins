/** CreateOS implementation of the subprocess capability seam. */

import { posix } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { environmentArguments, readRemoteEnvironment } from "./environment.ts";
import { CreateOSSubprocessHandle } from "./process.ts";
import { CreateOSTerminalHandle } from "./terminal.ts";

/** Managed process and PTY provider sharing `ctx.createos`. */
export class CreateOSSubprocessRuntime extends SubprocessRuntime {
  static inject = ["createos"];

  private readonly live = new Set<CreateOSSubprocessHandle>();
  private readonly terminals = new Set<CreateOSTerminalHandle>();
  private readonly environment: Promise<string>;
  private disposing = false;

  constructor(ctx: Context) {
    super(ctx);
    this.environment = ctx.createos.getSandbox().then((sandbox) => readRemoteEnvironment(sandbox));
    void this.environment.catch(() => {});
    ctx.effect(
      () => async () => {
        this.disposing = true;
        const processes = [...this.live];
        const terminals = [...this.terminals];
        for (const process of processes) process.terminate();
        const outcomes = await Promise.allSettled([
          ...processes.map(async (process) => {
            await process.waitForExit();
            await process.done;
          }),
          ...terminals.map((terminal) => terminal.terminate()),
        ]);
        this.live.clear();
        this.terminals.clear();
        const failures: unknown[] = [];
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") failures.push(outcome.reason as unknown);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(failures, "subprocess-createos: teardown failed");
      },
      "CreateOS subprocess teardown",
    );
  }

  /** @inheritdoc */
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0)
      throw new Error("subprocess-createos: executable name must be non-empty");
    if (command.includes("/") && !posix.isAbsolute(command)) {
      throw new Error(`subprocess-createos: relative executable paths are unsupported: ${command}`);
    }
    const sandbox = await this.ctx.createos.getSandbox();
    if (posix.isAbsolute(command)) {
      const result = await sandbox.runCommand(
        "/usr/bin/test",
        ["-f", command, "-a", "-x", command],
        {
          retry: false,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if (result.result.exit_code !== 0)
        throw new Error(`subprocess-createos: executable is unavailable: ${command}`);
      return command;
    }
    const args = environmentArguments(await this.environment, env);
    const result = await sandbox.runCommand(
      "/usr/bin/env",
      ["-i", ...args, "/bin/sh", "-c", 'command -v -- "$1"', "dsh-createos-resolve", command],
      { retry: false, ...(signal === undefined ? {} : { signal }) },
    );
    if (result.result.exit_code !== 0)
      throw new Error(`subprocess-createos: executable is unavailable: ${command}`);
    const executable = result.result.stdout.trim();
    if (executable.includes("\n") || (!posix.isAbsolute(executable) && !executable.includes("/"))) {
      throw new Error(`subprocess-createos: executable did not resolve to one path: ${command}`);
    }
    return posix.resolve(this.ctx.createos.cwd, executable);
  }

  /** @inheritdoc */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.disposing) throw new Error("subprocess-createos: service is disposing");
    requireGrace(spec.graceMs);
    if (spec.signal?.aborted === true)
      throw new Error(`aborted before spawn: ${String(spec.signal.reason)}`);
    const processes = this.ctx.createos.getProcesses();
    const handle = new CreateOSSubprocessHandlePromise(processes, this.environment, spec);
    this.live.add(handle);
    void handle.done.finally(() => this.live.delete(handle)).catch(() => {});
    return handle;
  }

  /** @inheritdoc */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.disposing) throw new Error("subprocess-createos: service is disposing");
    requireGrace(spec.graceMs);
    spec.signal?.throwIfAborted();
    const [sandbox, processes, environment] = await Promise.all([
      this.ctx.createos.getSandbox(),
      this.ctx.createos.getProcesses(),
      this.environment,
    ]);
    const terminal = await CreateOSTerminalHandle.create(
      sandbox,
      processes,
      environment,
      spec,
      environmentArguments,
    );
    this.terminals.add(terminal);
    void terminal.done.finally(() => this.terminals.delete(terminal)).catch(() => {});
    return terminal;
  }
}

class CreateOSSubprocessHandlePromise extends CreateOSSubprocessHandle {
  constructor(
    processes: ReturnType<Context["createos"]["getProcesses"]>,
    environment: Promise<string>,
    spec: SubprocessSpawnSpec,
  ) {
    const resolved = Promise.resolve(processes);
    // The synchronous seam publishes before the remote owner promise settles.
    super(new DeferredProcesses(resolved), environment, spec, environmentArguments);
  }
}

class DeferredProcesses {
  constructor(private readonly ready: ReturnType<Context["createos"]["getProcesses"]>) {}
  create(
    ...args: Parameters<
      import("@nodeops-createos/dsh-createos/createos").CreateOSProcesses["create"]
    >
  ) {
    return this.ready.then((processes) => processes.create(...args));
  }
  connect(
    ...args: Parameters<
      import("@nodeops-createos/dsh-createos/createos").CreateOSProcesses["connect"]
    >
  ) {
    const ready = this.ready;
    return (async function* () {
      const processes = await ready;
      yield* processes.connect(...args);
    })();
  }
  input(
    ...args: Parameters<
      import("@nodeops-createos/dsh-createos/createos").CreateOSProcesses["input"]
    >
  ) {
    return this.ready.then((processes) => processes.input(...args));
  }
  closeStdin(
    ...args: Parameters<
      import("@nodeops-createos/dsh-createos/createos").CreateOSProcesses["closeStdin"]
    >
  ) {
    return this.ready.then((processes) => processes.closeStdin(...args));
  }
  wait(
    ...args: Parameters<import("@nodeops-createos/dsh-createos/createos").CreateOSProcesses["wait"]>
  ) {
    return this.ready.then((processes) => processes.wait(...args));
  }
  terminate(
    ...args: Parameters<
      import("@nodeops-createos/dsh-createos/createos").CreateOSProcesses["terminate"]
    >
  ) {
    return this.ready.then((processes) => processes.terminate(...args));
  }
}

function requireGrace(graceMs: number): void {
  const maximum = Math.min(MAX_TIMER_DELAY_MS, 60_000);
  if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > maximum) {
    throw new Error(
      `subprocess graceMs must be a positive finite number no greater than ${maximum}`,
    );
  }
}

export default CreateOSSubprocessRuntime;
