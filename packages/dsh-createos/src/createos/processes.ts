/** Typed access to CreateOS managed process and PTY resources. */

import type { Branded } from "@deepseek-ai/dsh-brand";
import type { CreateosSandboxHttp } from "@nodeops-createos/sandbox";

const MAX_INPUT_BYTES = 256 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** Opaque managed-process resource id minted by the CreateOS guest agent. */
export type CreateOSProcessId = Branded<"CreateOSProcessId">;

/**
 * Validate and brand one CreateOS managed-process id.
 * @param value - untrusted resource id from the control plane.
 * @returns the validated opaque id.
 */
export function CreateOSProcessId(value: string): CreateOSProcessId {
  if (!/^proc_[A-Za-z0-9_-]{16,128}$/u.test(value)) {
    throw new Error(`dsh-createos: invalid managed process id: ${JSON.stringify(value)}`);
  }
  return value as CreateOSProcessId;
}

/** PTY dimensions supplied during managed-process creation. */
export interface CreateOSPTYOptions {
  /** Initial terminal column count. */
  cols: number;
  /** Initial terminal row count. */
  rows: number;
}

/** Exact process creation request accepted by CreateOS. */
export interface CreateOSProcessSpec {
  /** Executable path or name. */
  cmd: string;
  /** Exact arguments, excluding argv[0]. */
  args?: readonly string[];
  /** Absolute working directory. */
  cwd?: string;
  /** Process-local environment overrides accepted by the sandbox policy. */
  env?: Readonly<Record<string, string>>;
  /** PTY allocation options; omission creates an ordinary pipe process. */
  pty?: CreateOSPTYOptions;
}

/** Retained output bounds reported by the guest process manager. */
export interface CreateOSOutputSummary {
  /** Oldest retained output sequence. */
  oldest_seq: number;
  /** Newest retained output sequence. */
  newest_seq: number;
  /** Retained encoded payload bytes. */
  bytes: number;
}

/** Immutable CreateOS view of one managed process. */
export interface CreateOSProcessDetails {
  /** Opaque resource id. */
  process_id: CreateOSProcessId;
  /** Pipe process or PTY-backed process. */
  kind: "process" | "pty";
  /** Guest leader pid. */
  pid: number;
  /** Guest lifecycle state. */
  state: "starting" | "running" | "terminating" | "exited" | "failed" | "unknown";
  /** Whether the top-level process exited. */
  leader_exited: boolean;
  /** Whether the resource cgroup is empty. */
  tree_exited: boolean;
  /** RFC 3339 creation timestamp. */
  created_at: string;
  /** RFC 3339 leader completion timestamp. */
  finished_at: string | null;
  /** Numeric exit code, or null for signal termination. */
  exit_code: number | null;
  /** Signal reported by the guest, when signal-terminated. */
  signal?: string;
  /** Retained output journal bounds. */
  output: CreateOSOutputSummary;
}

/** One frame from a CreateOS process output connection. */
export type CreateOSProcessEvent =
  | { type: "data"; seq: number; stream: "stdout" | "stderr" | "pty"; data_base64: string }
  | { type: "exit"; exit_code?: number; signal?: string }
  | { type: "heartbeat" }
  | { type: "error"; error: string; oldest_available_seq?: number };

interface InputResponse {
  input_seq: number;
}

/** Authenticated client for the managed-process endpoints of one sandbox. */
export class CreateOSProcesses {
  constructor(
    private readonly http: CreateosSandboxHttp,
    private readonly sandboxId: string,
  ) {}

  /**
   * Create one pipe or PTY-backed process without retrying an ambiguous POST.
   * @param spec - exact managed-process allocation request.
   * @param signal - optional allocation cancellation.
   * @returns the validated allocated resource.
   */
  async create(spec: CreateOSProcessSpec, signal?: AbortSignal): Promise<CreateOSProcessDetails> {
    const details = await this.http.request<unknown>("POST", this.path(), {
      body: spec,
      retry: false,
      signal,
    });
    return validateDetails(details);
  }

  /**
   * List retained process resources.
   * @param signal - optional request cancellation.
   * @returns every validated resource retained by the sandbox agent.
   */
  async list(signal?: AbortSignal): Promise<CreateOSProcessDetails[]> {
    const response = await this.http.request<unknown>("GET", this.path(), { signal });
    if (!isRecord(response) || !Array.isArray(response.processes)) {
      throw new Error("dsh-createos: managed process list carried invalid data");
    }
    return response.processes.map(validateDetails);
  }

  /**
   * Inspect one retained process resource.
   * @param id - opaque resource identity.
   * @param signal - optional request cancellation.
   * @returns the validated current resource state.
   */
  async inspect(id: CreateOSProcessId, signal?: AbortSignal): Promise<CreateOSProcessDetails> {
    return validateDetails(
      await this.http.request<unknown>("GET", this.path(`/${id}`), { signal }),
    );
  }

  /**
   * Stream retained and live binary-safe output after one sequence.
   * @param id - opaque resource identity.
   * @param after - last consumed output sequence.
   * @param signal - optional stream cancellation.
   * @returns validated retained and live process events.
   */
  async *connect(
    id: CreateOSProcessId,
    after: number,
    signal?: AbortSignal,
  ): AsyncGenerator<CreateOSProcessEvent> {
    const events = this.http.stream<unknown>("GET", this.path(`/${id}/connect`), {
      query: { after },
      signal,
      timeoutMs: 0,
    });
    for await (const event of events) yield validateEvent(event);
  }

  /**
   * Write ordered bytes to process stdin or the PTY master.
   * @param id - opaque resource identity.
   * @param data - bytes split into API-sized requests.
   * @param signal - optional request cancellation.
   * @returns the final accepted input sequence, or zero for empty input.
   */
  async input(
    id: CreateOSProcessId,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<InputResponse> {
    let response: InputResponse = { input_seq: 0 };
    for (let offset = 0; offset < data.byteLength; offset += MAX_INPUT_BYTES) {
      const value = await this.http.request<unknown>("POST", this.path(`/${id}/input`), {
        body: {
          data_base64: Buffer.from(data.subarray(offset, offset + MAX_INPUT_BYTES)).toString(
            "base64",
          ),
        },
        retry: false,
        signal,
      });
      if (!isRecord(value) || !isNonnegativeInteger(value.input_seq)) {
        throw new Error("dsh-createos: managed process input carried an invalid sequence");
      }
      response = { input_seq: value.input_seq };
    }
    return response;
  }

  /**
   * Close an ordinary process stdin after accepted writes.
   * @param id - opaque resource identity.
   * @param signal - optional request cancellation.
   */
  async closeStdin(id: CreateOSProcessId, signal?: AbortSignal): Promise<void> {
    await this.http.request<unknown>("POST", this.path(`/${id}/stdin/close`), {
      retry: false,
      signal,
    });
  }

  /**
   * Resize a PTY-backed process.
   * @param id - opaque resource identity.
   * @param rows - positive terminal row count.
   * @param cols - positive terminal column count.
   * @param signal - optional request cancellation.
   */
  async resize(
    id: CreateOSProcessId,
    rows: number,
    cols: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.request<unknown>("POST", this.path(`/${id}/resize`), {
      body: { rows, cols },
      retry: false,
      signal,
    });
  }

  /**
   * Deliver a supported signal using the resource's mode-specific target.
   * @param id - opaque resource identity.
   * @param signalName - CreateOS-supported POSIX signal name.
   * @param signal - optional request cancellation.
   */
  async signal(id: CreateOSProcessId, signalName: string, signal?: AbortSignal): Promise<void> {
    await this.http.request<unknown>("POST", this.path(`/${id}/signal`), {
      body: { signal: signalName },
      retry: false,
      signal,
    });
  }

  /**
   * Long-poll for leader or complete-tree exit.
   * @param id - opaque resource identity.
   * @param scope - top-level leader or complete resource cgroup.
   * @param timeoutMs - server long-poll duration.
   * @param signal - optional request cancellation.
   * @returns the validated settled resource state.
   */
  async wait(
    id: CreateOSProcessId,
    scope: "leader" | "tree",
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CreateOSProcessDetails> {
    return validateDetails(
      await this.http.request<unknown>("GET", this.path(`/${id}/wait`), {
        query: { scope, timeout_ms: timeoutMs },
        signal,
        timeoutMs: timeoutMs + 5_000,
      }),
    );
  }

  /**
   * Idempotently terminate the resource cgroup and await quiescence.
   * @param id - opaque resource identity.
   * @param graceMs - TERM-to-cgroup-kill grace duration.
   * @param signal - optional request cancellation.
   * @returns the validated quiescent resource state.
   */
  async terminate(
    id: CreateOSProcessId,
    graceMs: number,
    signal?: AbortSignal,
  ): Promise<CreateOSProcessDetails> {
    return validateDetails(
      await this.http.request<unknown>("DELETE", this.path(`/${id}`), {
        query: { grace_ms: graceMs },
        signal,
        timeoutMs: Math.max(10_000, graceMs + 5_000),
      }),
    );
  }

  private path(suffix = ""): string {
    return `/v1/sandboxes/${encodeURIComponent(this.sandboxId)}/processes${suffix}`;
  }
}

function validateDetails(value: unknown): CreateOSProcessDetails {
  if (!isRecord(value))
    throw new Error("dsh-createos: managed process response carried invalid data");
  const id = typeof value.process_id === "string" ? CreateOSProcessId(value.process_id) : undefined;
  if (id === undefined || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) {
    throw new Error("dsh-createos: managed process response carried an invalid pid");
  }
  if (value.kind !== "process" && value.kind !== "pty")
    throw new Error("dsh-createos: managed process response carried an invalid kind");
  if (!PROCESS_STATES.has(String(value.state)))
    throw new Error("dsh-createos: managed process response carried an invalid state");
  if (typeof value.leader_exited !== "boolean" || typeof value.tree_exited !== "boolean") {
    throw new Error("dsh-createos: managed process response carried invalid exit state");
  }
  if (
    typeof value.created_at !== "string" ||
    (value.finished_at !== null && typeof value.finished_at !== "string")
  ) {
    throw new Error("dsh-createos: managed process response carried invalid timestamps");
  }
  if (value.exit_code !== null && !Number.isSafeInteger(value.exit_code)) {
    throw new Error("dsh-createos: managed process response carried an invalid exit code");
  }
  if (value.signal !== undefined && typeof value.signal !== "string") {
    throw new Error("dsh-createos: managed process response carried an invalid signal");
  }
  if (
    !isRecord(value.output) ||
    !isNonnegativeInteger(value.output.oldest_seq) ||
    !isNonnegativeInteger(value.output.newest_seq) ||
    !isNonnegativeInteger(value.output.bytes)
  ) {
    throw new Error("dsh-createos: managed process response carried invalid output bounds");
  }
  return value as unknown as CreateOSProcessDetails;
}

const PROCESS_STATES = new Set([
  "starting",
  "running",
  "terminating",
  "exited",
  "failed",
  "unknown",
]);

function validateEvent(value: unknown): CreateOSProcessEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("dsh-createos: managed process stream carried invalid data");
  }
  if (value.type === "heartbeat") return { type: "heartbeat" };
  if (value.type === "exit") {
    if (
      value.exit_code !== undefined &&
      value.exit_code !== null &&
      !Number.isSafeInteger(value.exit_code)
    ) {
      throw new Error("dsh-createos: managed process stream carried an invalid exit code");
    }
    if (value.signal !== undefined && value.signal !== null && typeof value.signal !== "string") {
      throw new Error("dsh-createos: managed process stream carried an invalid signal");
    }
    return {
      type: "exit",
      ...(typeof value.exit_code === "number" ? { exit_code: value.exit_code } : {}),
      ...(typeof value.signal === "string" ? { signal: value.signal } : {}),
    };
  }
  if (value.type === "error") {
    if (
      typeof value.error !== "string" ||
      (value.oldest_available_seq !== undefined &&
        !isNonnegativeInteger(value.oldest_available_seq))
    ) {
      throw new Error("dsh-createos: managed process stream carried an invalid error");
    }
    return {
      type: "error",
      error: value.error,
      ...(typeof value.oldest_available_seq === "number"
        ? { oldest_available_seq: value.oldest_available_seq }
        : {}),
    };
  }
  if (value.type === "data") {
    if (
      !isNonnegativeInteger(value.seq) ||
      (value.stream !== "stdout" && value.stream !== "stderr" && value.stream !== "pty") ||
      typeof value.data_base64 !== "string" ||
      !BASE64.test(value.data_base64)
    ) {
      throw new Error("dsh-createos: managed process stream carried invalid output data");
    }
    return value as unknown as CreateOSProcessEvent;
  }
  throw new Error(
    `dsh-createos: managed process stream carried an unknown event type: ${value.type}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
