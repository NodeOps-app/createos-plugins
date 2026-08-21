import { Context } from "@deepseek-ai/cordis";
import CreateOSRuntime, {
  CreateOSProcessId,
  CreateOSProcesses,
} from "@nodeops-createos/dsh-createos/createos";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock("@nodeops-createos/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@nodeops-createos/sandbox")>();
  return { ...actual, createClient: () => sdk.client };
});

function details(id = "proc_abcdefghijklmnopqrstuv") {
  return {
    process_id: id,
    kind: "process" as const,
    pid: 42,
    state: "running" as const,
    leader_exited: false,
    tree_exited: false,
    created_at: "2026-08-19T00:00:00Z",
    finished_at: null,
    exit_code: null,
    output: { oldest_seq: 0, newest_seq: 0, bytes: 0 },
  };
}

describe("CreateOSProcesses", () => {
  it("uses opaque ids, disables create retries, and preserves reconnect offsets", async () => {
    const request = vi.fn().mockResolvedValue(details());
    const stream = vi.fn(() =>
      (async function* () {
        yield { type: "heartbeat" as const };
      })(),
    );
    const processes = new CreateOSProcesses({ request, stream } as never, "sb_test");

    const created = await processes.create({ cmd: "/bin/true", args: [] });
    expect(created.process_id).toBe("proc_abcdefghijklmnopqrstuv");
    expect(request).toHaveBeenCalledWith("POST", "/v1/sandboxes/sb_test/processes", {
      body: { cmd: "/bin/true", args: [] },
      retry: false,
      signal: undefined,
    });

    const iterator = processes.connect(created.process_id, 7);
    await iterator.next();
    expect(stream).toHaveBeenCalledWith(
      "GET",
      `/v1/sandboxes/sb_test/processes/${created.process_id}/connect`,
      {
        query: { after: 7 },
        signal: undefined,
        timeoutMs: 0,
      },
    );
  });

  it("rejects malformed cross-boundary ids", () => {
    expect(() => CreateOSProcessId("../process")).toThrow("invalid managed process id");
  });

  it("splits input at the API limit and rejects malformed stream events", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ input_seq: 1 })
      .mockResolvedValueOnce({ input_seq: 2 });
    const stream = vi.fn(() =>
      (async function* () {
        yield { type: "data", seq: -1 };
      })(),
    );
    const processes = new CreateOSProcesses({ request, stream } as never, "sb_test");
    const id = CreateOSProcessId("proc_abcdefghijklmnopqrstuv");

    await expect(processes.input(id, new Uint8Array(256 * 1024 + 1))).resolves.toEqual({
      input_seq: 2,
    });
    expect(request).toHaveBeenCalledTimes(2);
    await expect(processes.connect(id, 0).next()).rejects.toThrow("invalid output data");
  });
});

describe("CreateOSRuntime", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("creates one shared sandbox, protects its runtime directory, and awaits destruction", async () => {
    const runCommand = vi.fn(async (command: string) => ({
      result: {
        exit_code: 0,
        stdout: command === "/usr/bin/stat" ? "directory\n" : "",
        stderr: "",
      },
    }));
    const destroy = vi.fn().mockResolvedValue({ id: "sb_test", status: "destroying" });
    const waitUntilDestroyed = vi
      .fn()
      .mockImplementation(async function (this: { status: string }) {
        this.status = "destroyed";
        return this;
      });
    const sandbox = { id: "sb_test", status: "running", runCommand, destroy, waitUntilDestroyed };
    const createSandbox = vi.fn().mockResolvedValue(sandbox);
    sdk.client = { createSandbox, http: {} };

    const ctx = new Context();
    const fiber = await ctx.plugin(CreateOSRuntime, { apiKey: "key", shape: "s-2vcpu-2gb" });
    const service = ctx.createos;
    await expect(service.getSandbox()).resolves.toBe(sandbox);
    expect(createSandbox).toHaveBeenCalledWith({ shape: "s-2vcpu-2gb" }, { retry: false });
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      "/bin/mkdir",
      ["-p", "--", "/root/workspace", "/root/workspace/.dsh-createos"],
      { retry: false },
    );

    await fiber.dispose();
    expect(destroy).toHaveBeenCalledWith({ retry: false });
    expect(waitUntilDestroyed).toHaveBeenCalledOnce();
    await expect(service.getSandbox()).rejects.toThrow("disposing");
  });
});
