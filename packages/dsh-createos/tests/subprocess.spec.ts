import { Buffer } from "node:buffer";
import { once } from "node:events";
import type {
  CreateOSProcessDetails,
  CreateOSProcessEvent,
  CreateOSProcessSpec,
} from "@nodeops-createos/dsh-createos/createos";
import type { SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import { describe, expect, it } from "vitest";
import { environmentArguments } from "../src/subprocess/environment.ts";
import { CreateOSSubprocessHandle } from "../src/subprocess/process.ts";
import type { CreateOSProcessOperations } from "../src/subprocess/shared.ts";

function processDetails(overrides: Partial<CreateOSProcessDetails> = {}): CreateOSProcessDetails {
  return {
    process_id: "proc_abcdefghijklmnopqrstuv" as CreateOSProcessDetails["process_id"],
    kind: "process",
    pid: 4242,
    state: "running",
    leader_exited: false,
    tree_exited: false,
    created_at: "2026-08-19T00:00:00Z",
    finished_at: null,
    exit_code: null,
    output: { oldest_seq: 0, newest_seq: 0, bytes: 0 },
    ...overrides,
  };
}

class FakeProcesses implements CreateOSProcessOperations {
  createdSpec: CreateOSProcessSpec | undefined;
  readonly inputs: string[] = [];
  closes = 0;

  async create(spec: CreateOSProcessSpec): Promise<CreateOSProcessDetails> {
    this.createdSpec = spec;
    return processDetails();
  }

  async *connect(): AsyncGenerator<CreateOSProcessEvent> {
    const args = this.createdSpec?.args as string[];
    const marker = args[3] as string;
    yield {
      type: "data",
      seq: 1,
      stream: "stdout",
      data_base64: Buffer.from(marker).toString("base64"),
    };
    while (this.inputs.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    yield {
      type: "data",
      seq: 2,
      stream: "stdout",
      data_base64: Buffer.from("hello\n").toString("base64"),
    };
    yield {
      type: "data",
      seq: 3,
      stream: "stderr",
      data_base64: Buffer.from("warning\n").toString("base64"),
    };
    yield { type: "exit", exit_code: 0 };
  }

  async input(
    _id: CreateOSProcessDetails["process_id"],
    data: Uint8Array,
  ): Promise<{ input_seq: number }> {
    this.inputs.push(Buffer.from(data).toString());
    return { input_seq: this.inputs.length };
  }

  async closeStdin(): Promise<void> {
    this.closes += 1;
  }
  async wait(): Promise<CreateOSProcessDetails> {
    return processDetails({ leader_exited: true, tree_exited: true });
  }
  async terminate(): Promise<CreateOSProcessDetails> {
    return processDetails({
      state: "exited",
      leader_exited: true,
      tree_exited: true,
      signal: "terminated",
    });
  }
}

const baseSpec: SubprocessSpawnSpec = {
  argv: ["/bin/echo", "hello"],
  cwd: "/root/workspace",
  stdio: {
    stdin: { data: "payload" },
    stdout: { maxBytes: 64 },
    stderr: "pipe",
  },
  graceMs: 100,
  env: { EXPLICIT: "yes" },
};

describe("CreateOSSubprocessHandle", () => {
  it("opens the private start gate, streams both pipes, and closes batch stdin", async () => {
    const processes = new FakeProcesses();
    const handle = new CreateOSSubprocessHandle(
      processes,
      Promise.resolve("PATH=/usr/bin\0NPM_TOKEN=secret\0"),
      baseSpec,
      environmentArguments,
    );
    const stderr = [] as Buffer[];
    handle.stderr?.on("data", (chunk) => stderr.push(chunk as Buffer));

    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null });
    expect(handle.pid).toBe(4242);
    expect(processes.inputs).toHaveLength(2);
    expect(processes.inputs[0]).toMatch(/^dsh-[0-9a-f-]+\n$/u);
    expect(processes.inputs[1]).toBe("payload");
    expect(processes.closes).toBe(1);
    expect(handle.collected.stdout?.readFrom(0)).toMatchObject({ text: "hello\n", lossy: false });
    expect(Buffer.concat(stderr).toString()).toBe("warning\n");
    expect(processes.createdSpec?.env).toBeUndefined();
    expect(processes.createdSpec?.args).toContain("EXPLICIT=yes");
    expect(processes.createdSpec?.args).not.toContain("NPM_TOKEN=secret");
  });

  it("terminates through the cgroup-backed resource endpoint", async () => {
    const processes = new FakeProcesses();
    processes.connect = async function* () {
      const args = processes.createdSpec?.args as string[];
      yield {
        type: "data",
        seq: 1,
        stream: "stdout",
        data_base64: Buffer.from(args[3] as string).toString("base64"),
      };
      await new Promise(() => {});
    };
    const handle = new CreateOSSubprocessHandle(
      processes,
      Promise.resolve("PATH=/usr/bin\0"),
      { ...baseSpec, stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" } },
      environmentArguments,
    );
    while (handle.pid < 0) await new Promise((resolve) => setTimeout(resolve, 0));
    handle.terminate();
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: "SIGTERM" });
    await expect(handle.waitForExit()).resolves.toBe(true);
  });

  it("keeps raw pipe streams readable through completion", async () => {
    const processes = new FakeProcesses();
    const handle = new CreateOSSubprocessHandle(
      processes,
      Promise.resolve("PATH=/usr/bin\0"),
      { ...baseSpec, stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" } },
      environmentArguments,
    );
    const output: Buffer[] = [];
    handle.stdout?.on("data", (chunk) => output.push(chunk as Buffer));
    await handle.done;
    if (handle.stdout !== undefined) await once(handle.stdout, "close").catch(() => {});
    expect(Buffer.concat(output).toString()).toBe("hello\n");
  });
});
