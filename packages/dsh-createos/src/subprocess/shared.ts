/** Shared CreateOS managed-process helpers. */

import { randomUUID } from "node:crypto";
import type {
  CreateOSProcessDetails,
  CreateOSProcessEvent,
  CreateOSProcesses,
} from "@nodeops-createos/dsh-createos/createos";
import type { SubprocessOutcome } from "@deepseek-ai/dsh-subprocess";

/** Private marker and gate used to attach output before the requested executable starts. */
export function startGate(pty: boolean): { marker: string; token: string; script: string } {
  const marker = `__DSH_CREATEOS_READY_${randomUUID()}__`;
  const token = `dsh-${randomUUID()}`;
  const terminalPrefix = pty ? "stty -echo; " : "";
  const terminalSuffix = pty ? "stty echo; " : "";
  return {
    marker,
    token,
    script: `${terminalPrefix}printf '%s' "$1"; dsh_gate="$2"; shift 2; IFS= read -r dsh_seen; test "$dsh_seen" = "$dsh_gate" || exit 125; ${terminalSuffix}exec /usr/bin/env -i "$@"`,
  };
}

/** Map CreateOS/Go signal vocabulary into the Node subprocess seam. */
export function processOutcome(details: {
  exit_code: number | null;
  signal?: string | undefined;
}): SubprocessOutcome {
  return {
    exitCode: details.exit_code,
    signal: normalizeSignal(details.signal),
  };
}

function normalizeSignal(value: string | undefined): NodeJS.Signals | null {
  if (value === undefined || value.length === 0) return null;
  const canonical = value.startsWith("SIG") ? value : SIGNAL_NAMES[value.toLowerCase()];
  if (canonical === undefined || !SIGNAL_SET.has(canonical)) {
    throw new Error(`subprocess-createos: unknown exit signal ${JSON.stringify(value)}`);
  }
  return canonical as NodeJS.Signals;
}

const SIGNAL_NAMES: Readonly<Record<string, NodeJS.Signals>> = {
  aborted: "SIGABRT",
  alarm: "SIGALRM",
  "bus error": "SIGBUS",
  "broken pipe": "SIGPIPE",
  child: "SIGCHLD",
  continued: "SIGCONT",
  "floating point exception": "SIGFPE",
  hangup: "SIGHUP",
  "illegal instruction": "SIGILL",
  interrupt: "SIGINT",
  killed: "SIGKILL",
  quit: "SIGQUIT",
  "segmentation fault": "SIGSEGV",
  stopped: "SIGSTOP",
  "stopped (tty input)": "SIGTTIN",
  "stopped (tty output)": "SIGTTOU",
  "stopped (signal)": "SIGTSTP",
  terminated: "SIGTERM",
  "trace/breakpoint trap": "SIGTRAP",
  "urgent i/o condition": "SIGURG",
  "user defined signal 1": "SIGUSR1",
  "user defined signal 2": "SIGUSR2",
  "window changed": "SIGWINCH",
  "cpu time limit exceeded": "SIGXCPU",
  "file size limit exceeded": "SIGXFSZ",
};

const SIGNAL_SET = new Set<string>([
  ...Object.values(SIGNAL_NAMES),
  "SIGIO",
  "SIGPOLL",
  "SIGPROF",
  "SIGSYS",
  "SIGVTALRM",
]);

/** Managed-process operations consumed by ordinary remote handles. */
export type CreateOSProcessOperations = Pick<
  CreateOSProcesses,
  "create" | "connect" | "input" | "closeStdin" | "wait" | "terminate"
>;

/** Long-poll until one requested process scope exits or cancellation wins. */
export async function waitScope(
  processes: Pick<CreateOSProcesses, "wait">,
  id: CreateOSProcessDetails["process_id"],
  scope: "leader" | "tree",
  signal?: AbortSignal,
): Promise<CreateOSProcessDetails | undefined> {
  for (;;) {
    if (signal?.aborted === true) return undefined;
    try {
      return await processes.wait(id, scope, 30_000, signal);
    } catch (error: unknown) {
      if (isAborted(signal)) return undefined;
      if (isWaitTimeout(error)) continue;
      throw error;
    }
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isWaitTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("statusCode" in error && error.statusCode === 408) ||
      ("name" in error && error.name === "CreateosSandboxTimeoutError"))
  );
}

/** Require the terminal event kinds used by the provider. */
export function assertProcessEvent(event: CreateOSProcessEvent): void {
  if (event.type === "error")
    throw new Error(`subprocess-createos: output stream failed: ${event.error}`);
}
