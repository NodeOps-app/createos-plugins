import { Buffer } from "node:buffer";
import type {
  CreateOSProcessDetails,
  CreateOSProcessEvent,
  CreateOSProcessSpec,
  CreateOSSandbox,
} from "@nodeops-createos/dsh-createos/createos";
import { describe, expect, it, vi } from "vitest";
import { environmentArguments } from "../src/subprocess/environment.ts";
import { CreateOSTerminalHandle } from "../src/subprocess/terminal.ts";

function details(): CreateOSProcessDetails {
  return {
    process_id: "proc_abcdefghijklmnopqrstuv" as CreateOSProcessDetails["process_id"],
    kind: "pty",
    pid: 88,
    state: "running",
    leader_exited: false,
    tree_exited: false,
    created_at: "2026-08-19T00:00:00Z",
    finished_at: null,
    exit_code: null,
    output: { oldest_seq: 0, newest_seq: 0, bytes: 0 },
  };
}

describe("CreateOSTerminalHandle", () => {
  it("allocates an arbitrary PTY command and reports the group it signals", async () => {
    let spec: CreateOSProcessSpec | undefined;
    const inputs: string[] = [];
    const processes = {
      create: vi.fn(async (value: CreateOSProcessSpec) => {
        spec = value;
        return details();
      }),
      connect: () =>
        (async function* (): AsyncGenerator<CreateOSProcessEvent> {
          const marker = spec?.args?.[3] ?? "";
          yield {
            type: "data",
            seq: 1,
            stream: "pty",
            data_base64: Buffer.from(marker).toString("base64"),
          };
          while (inputs.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
          yield {
            type: "data",
            seq: 2,
            stream: "pty",
            data_base64: Buffer.from("prompt$ ").toString("base64"),
          };
          yield { type: "exit", exit_code: 0 };
        })(),
      input: vi.fn(async (_id, data: Uint8Array) => {
        inputs.push(Buffer.from(data).toString());
        return { input_seq: inputs.length };
      }),
      signal: vi.fn(async () => {}),
      terminate: vi.fn(async () => ({
        ...details(),
        state: "exited" as const,
        leader_exited: true,
        tree_exited: true,
        signal: "terminated",
      })),
    };
    const runCommand = vi.fn(async (command: string) =>
      command === "/bin/ps"
        ? { result: { exit_code: 0, stdout: "99\n", stderr: "" } }
        : { result: { exit_code: 0, stdout: "", stderr: "" } },
    );
    const sandbox = { runCommand } as unknown as CreateOSSandbox;

    const terminal = await CreateOSTerminalHandle.create(
      sandbox,
      processes as never,
      "PATH=/usr/bin\0",
      { argv: ["/bin/bash", "-il"], cwd: "/root/workspace", rows: 24, cols: 80, graceMs: 100 },
      environmentArguments,
    );
    expect(spec?.pty).toEqual({ rows: 24, cols: 80 });
    await expect(terminal.inspectForeground()).resolves.toEqual({
      processGroupId: 99,
      inputWaiting: false,
    });
    await expect(terminal.signalForeground("SIGTSTP")).resolves.toBe(99);
    expect(runCommand).toHaveBeenLastCalledWith(
      "/bin/kill",
      ["-TSTP", "--", "-99"],
      expect.any(Object),
    );
    await expect(terminal.signalForeground("SIGINT")).resolves.toBe(99);
    expect(processes.signal).toHaveBeenCalledWith(
      details().process_id,
      "SIGINT",
      expect.any(AbortSignal),
    );
    await expect(terminal.done).resolves.toEqual({ exitCode: 0, signal: null });
  });
});
