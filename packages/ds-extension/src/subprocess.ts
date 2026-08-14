/**
 * CreateOS provider for the subprocess capability seam. Every managed process
 * runs inside the sandbox owned by `ctx.createos`, in the same execution world
 * as the filesystem adapter.
 *
 * The exec endpoint is request-scoped: it streams stdout/stderr/exit over
 * NDJSON but hands back no pid and no signal channel. Termination therefore
 * brands each spawn with an inherited marker environment variable and signals
 * every process still carrying it, which is tree-scoped by construction.
 * @module @createos/dsh/subprocess
 */

import { PassThrough, type Readable, type Writable } from "node:stream";
import { posix } from "node:path";
import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import type {
  SubprocessCollect,
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import type { Sandbox } from "@nodeops-createos/sandbox";
import {
  envArgv,
  execScript,
  execScriptChecked,
  SIGNAL_TREE_SCRIPT,
  SPAWN_MARKER_ENV,
  STDIN_WRAPPER,
  TREE_ALIVE_SCRIPT,
} from "./exec.ts";
import { CollectedStream } from "./output.ts";

const LIVENESS_POLL_MS = 250;

/**
 * Resolve a bare name to a real executable file on PATH.
 *
 * Deliberately NOT `command -v`: for a name that is also a shell builtin
 * (`echo`, `test`, `kill`, ...) that reports the builtin name rather than a
 * path, and this seam owes its caller an absolute path it can hand to another
 * OS capability. Scanning PATH for an executable regular file skips builtins
 * and aliases entirely.
 *
 * `$1` is the command; `$2` is a PATH override (empty to keep the ambient one).
 */
const LOOKUP_SCRIPT = `p=$1
if [ -n "$2" ]; then PATH=$2; export PATH; fi
case $p in
  /*)
    if [ -f "$p" ] && [ -x "$p" ]; then printf %s "$p"; exit 0; fi
    exit 127
    ;;
esac
IFS=:
for d in $PATH; do
  [ -n "$d" ] || d=.
  if [ -f "$d/$p" ] && [ -x "$d/$p" ]; then printf %s "$d/$p"; exit 0; fi
done
exit 127`;

function isCollect(mode: SubprocessSpawnSpec["stdio"]["stdout"]): mode is SubprocessCollect {
  return typeof mode === "object";
}

/** One managed remote process tree. */
class CreateosHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined = undefined;
  readonly stdout: Readable | undefined;
  readonly stderr: Readable | undefined;
  readonly collected: SubprocessCollectedOutputs;
  readonly done: Promise<SubprocessOutcome>;

  /**
   * The guest pid is not observable through the exec endpoint, so this stays 0
   * ("unknown") for a running process and becomes -1 when the spawn failed
   * outright. Termination never depends on it — the inherited marker does.
   */
  private currentPid = 0;
  private readonly marker = randomUUID();
  private readonly stdoutPipe: PassThrough | undefined;
  private readonly stderrPipe: PassThrough | undefined;
  private readonly stdoutCollected: CollectedStream | undefined;
  private readonly stderrCollected: CollectedStream | undefined;
  private terminatedWith: NodeJS.Signals | undefined;
  private settled = false;
  private killTimer: NodeJS.Timeout | undefined;
  private resolveDone!: (outcome: SubprocessOutcome) => void;
  private rejectDone!: (error: unknown) => void;

  constructor(
    private readonly runtime: CreateosSubprocess,
    private readonly spec: SubprocessSpawnSpec,
  ) {
    const { stdout, stderr } = spec.stdio;
    this.stdoutPipe = stdout === "pipe" ? new PassThrough() : undefined;
    this.stderrPipe = stderr === "pipe" ? new PassThrough() : undefined;
    this.stdout = this.stdoutPipe;
    this.stderr = this.stderrPipe;
    this.stdoutCollected = isCollect(stdout) ? new CollectedStream(stdout) : undefined;
    this.stderrCollected = isCollect(stderr) ? new CollectedStream(stderr) : undefined;
    this.collected = {
      ...(this.stdoutCollected !== undefined ? { stdout: this.stdoutCollected } : {}),
      ...(this.stderrCollected !== undefined ? { stderr: this.stderrCollected } : {}),
    };
    this.done = new Promise<SubprocessOutcome>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    void this.run();
  }

  get pid(): number {
    return this.currentPid;
  }

  terminate(): void {
    if (this.settled || this.terminatedWith !== undefined) return;
    this.terminatedWith = "SIGTERM";
    void this.signalTree("TERM");
    this.killTimer = setTimeout(() => {
      if (this.settled) return;
      this.terminatedWith = "SIGKILL";
      void this.signalTree("KILL");
    }, this.spec.graceMs);
    // A pending escalation must never hold the harness process open by itself.
    this.killTimer.unref();
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    while (signal?.aborted !== true) {
      let alive: string;
      try {
        const sandbox = await this.runtime.sandbox();
        alive = await execScriptChecked(sandbox, TREE_ALIVE_SCRIPT, [this.marker]);
      } catch {
        // The world is gone (sandbox disposing/destroyed), so no member of the
        // tree can still be running.
        return true;
      }
      if (alive === "gone") return true;
      const waited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), LIVENESS_POLL_MS);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve(false);
          },
          { once: true },
        );
      });
      if (!waited) return false;
    }
    return false;
  }

  private async signalTree(signalName: "TERM" | "KILL"): Promise<void> {
    try {
      const sandbox = await this.runtime.sandbox();
      await execScript(sandbox, SIGNAL_TREE_SCRIPT, [signalName, this.marker]);
    } catch {
      // Nothing left to signal once the sandbox itself is unreachable.
    }
  }

  private async run(): Promise<void> {
    let onAbort: (() => void) | undefined;
    try {
      const sandbox = await this.runtime.sandbox();
      const stdinPath = await this.stageStdin(sandbox);

      if (this.spec.signal?.aborted === true) {
        this.terminate();
      } else if (this.spec.signal !== undefined) {
        onAbort = () => this.terminate();
        this.spec.signal.addEventListener("abort", onAbort, { once: true });
      }

      const { cmd, args } = envArgv(
        this.spec.cwd,
        { ...this.spec.env, [SPAWN_MARKER_ENV]: this.marker },
        ["sh", "-c", STDIN_WRAPPER, "dsh", stdinPath, ...this.spec.argv],
      );

      let exitCode: number | null = null;
      for await (const event of sandbox.streamCommand(cmd, args)) {
        switch (event.type) {
          case "stdout":
            this.deliver("stdout", event.data);
            break;
          case "stderr":
            this.deliver("stderr", event.data);
            break;
          case "exit":
            exitCode = event.exitCode;
            break;
          case "error":
            throw new Error(event.message);
          default:
            break;
        }
      }
      await this.settle(sandbox, exitCode);
    } catch (error: unknown) {
      this.settled = true;
      if (this.killTimer !== undefined) clearTimeout(this.killTimer);
      this.currentPid = -1;
      this.closePipes();
      this.rejectDone(error);
    } finally {
      if (onAbort !== undefined) this.spec.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Stage batch stdin as a file, since the exec endpoint carries no stdin stream. */
  private async stageStdin(sandbox: Sandbox): Promise<string> {
    const mode = this.spec.stdio.stdin;
    if (mode === "ignore") return "";
    if (mode === "pipe") {
      throw new Error(
        'dsh-createos: stdin "pipe" needs a bidirectional channel the CreateOS exec endpoint does not expose; ' +
          "use a batch { data } stdin, or run this consumer against a local subprocess provider",
      );
    }
    const path = posix.join(this.runtime.runtimeRoot, `stdin-${this.marker}`);
    await sandbox.files.upload(path, mode.data);
    return path;
  }

  private deliver(stream: "stdout" | "stderr", text: string): void {
    const mode = stream === "stdout" ? this.spec.stdio.stdout : this.spec.stdio.stderr;
    if (mode === "inherit") {
      const sink = stream === "stdout" ? process.stdout : process.stderr;
      sink.write(text);
      return;
    }
    if (mode === "pipe") {
      const pipe = stream === "stdout" ? this.stdoutPipe : this.stderrPipe;
      pipe?.write(text);
      return;
    }
    const collected = stream === "stdout" ? this.stdoutCollected : this.stderrCollected;
    collected?.append(text);
  }

  private async settle(sandbox: Sandbox, exitCode: number | null): Promise<void> {
    this.settled = true;
    if (this.killTimer !== undefined) clearTimeout(this.killTimer);
    await this.publishSpills(sandbox);
    this.closePipes();
    // A process this handle killed reports the signal it was killed with; the
    // exec endpoint only ever reports a numeric status.
    this.resolveDone(
      this.terminatedWith !== undefined
        ? { exitCode: null, signal: this.terminatedWith }
        : { exitCode, signal: null },
    );
  }

  /**
   * Publish complete-stream spill files once the process has settled.
   *
   * ponytail: the spill lands in one upload at exit rather than growing during
   * the run, so a still-running process has no spill file yet. Stream it
   * incrementally only if a consumer needs mid-run recovery.
   */
  private async publishSpills(sandbox: Sandbox): Promise<void> {
    const pending: Array<[CollectedStream, string]> = [];
    if (this.stdoutCollected?.truncated === true) pending.push([this.stdoutCollected, "stdout"]);
    if (this.stderrCollected?.truncated === true) pending.push([this.stderrCollected, "stderr"]);
    for (const [collected, name] of pending) {
      const content = collected.spillContent;
      if (content === undefined) continue;
      const path = posix.join(this.runtime.runtimeRoot, `${name}-${this.marker}.log`);
      try {
        await sandbox.files.upload(path, content);
        collected.publishSpill(path);
      } catch {
        // Losing the spill downgrades recovery but must not fail the process outcome.
      }
    }
  }

  private closePipes(): void {
    this.stdoutPipe?.end();
    this.stderrPipe?.end();
  }
}

/** Subprocess backend sharing the sandbox owned by `ctx.createos`. */
export class CreateosSubprocess extends SubprocessRuntime {
  static inject = ["createos"];

  private readonly live = new Set<CreateosHandle>();

  constructor(ctx: Context) {
    super(ctx);
    ctx.effect(
      () => async () => {
        // Disposal terminates every still-running managed process and awaits the
        // trees, so nothing survives the provider that started it.
        const handles = [...this.live];
        for (const handle of handles) handle.terminate();
        await Promise.all(handles.map((handle) => handle.waitForExit()));
      },
      "createos subprocess teardown",
    );
  }

  /** The runtime directory adapters use for staged stdin and spill files. */
  get runtimeRoot(): string {
    return this.ctx.createos.runtimeRoot;
  }

  /** The shared sandbox handle. */
  async sandbox(): Promise<Sandbox> {
    return this.ctx.createos.getSandbox();
  }

  override async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error("dsh-createos: executable name must be non-empty");
    if (!posix.isAbsolute(command) && command.includes("/")) {
      throw new Error(`dsh-createos: relative executable paths are ambiguous: ${command}`);
    }
    const sandbox = await this.sandbox();
    const resolved = (
      await execScriptChecked(sandbox, LOOKUP_SCRIPT, [command, env?.PATH ?? ""], signal)
    ).trim();
    if (!posix.isAbsolute(resolved)) {
      throw new Error(`dsh-createos: could not resolve executable: ${command}`);
    }
    return resolved;
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const handle = new CreateosHandle(this, spec);
    this.live.add(handle);
    void handle.done.catch(() => undefined).finally(() => this.live.delete(handle));
    return handle;
  }

  override async spawnTerminal(
    _spec: SubprocessTerminalSpawnSpec,
  ): Promise<SubprocessTerminalHandle> {
    // CreateOS does expose a keyless PTY (`POST /v1/sandboxes/{id}/shell` and
    // `GET /shell-ws`), but neither is reachable through the SDK's exec client
    // yet, and foreground process-group inspection has no CreateOS equivalent.
    // Consumers that need a real terminal should run a local subprocess provider.
    throw new Error(
      "dsh-createos: terminal sessions are not implemented yet; mount a local subprocess provider for PTY consumers",
    );
  }
}

export default CreateosSubprocess;
