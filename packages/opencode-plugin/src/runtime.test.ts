import { describe, test, expect } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { CLI, type Result } from "./cli.ts";
import { configure } from "./config.ts";
import { Runtime } from "./runtime.ts";

const result = (value: unknown): Result => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: "",
  truncated: false,
});
function fixture(persist = true) {
  const entries = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => entries.get(key),
    set: async (key: string, value: unknown) => {
      entries.set(key, value);
    },
    remove: async (key: string) => {
      entries.delete(key);
    },
  } as Plugin.Context["storage"];
  const calls: string[][] = [];
  let allocations = 0;
  const cli = new CLI(async (args) => {
    calls.push(args);
    if (args.includes("create")) return result({ id: `box-${++allocations}` });
    if (args.includes("get")) return result({ id: args.at(-1), status: "running" });
    return result({});
  });
  const config = configure({ mode: "remote", persist }, {});
  return {
    cli,
    storage,
    calls,
    entries,
    runtime: new Runtime(cli, config, "/project", storage),
    config,
  };
}
describe("session ownership", () => {
  test("concurrent calls share allocation; different sessions do not", async () => {
    const { runtime, calls } = fixture();
    const [first, second, third] = await Promise.all([
      runtime.ensure("a"),
      runtime.ensure("a"),
      runtime.ensure("b"),
    ]);
    expect(first.id).toBe(second.id);
    expect(third.id).not.toBe(first.id);
    expect(calls.filter((args) => args.includes("create"))).toHaveLength(2);
    await runtime.close();
    expect(calls.some((args) => args.includes("rm"))).toBe(false);
  });
  test("durable binding reattaches after reload without allocating or staging again", async () => {
    const { runtime, cli, storage, config, calls } = fixture();
    const first = await runtime.ensure("a");
    await runtime.close();
    const reloaded = new Runtime(cli, config, "/project", storage);
    expect((await reloaded.ensure("a")).id).toBe(first.id);
    expect(calls.filter((args) => args.includes("create"))).toHaveLength(1);
    await reloaded.close();
  });
  test("release refuses active work and remote selection survives release", async () => {
    const { runtime } = fixture();
    await runtime.ensure("a");
    const gate = Promise.withResolvers<void>();
    const task = runtime.task("a", undefined, () => gate.promise);
    await expect(runtime.release("a", true)).rejects.toThrow("finish");
    gate.resolve();
    await task;
    await runtime.release("a", true);
    expect(runtime.remote("a")).toBe(true);
    expect(runtime.status("a").sandbox).toBeNull();
    await runtime.close();
  });
  test("ephemeral owner destroys resources on unload", async () => {
    const { runtime, calls } = fixture(false);
    await runtime.ensure("a");
    await runtime.close();
    expect(calls.filter((args) => args.includes("rm"))).toHaveLength(1);
    await expect(runtime.ensure("b")).rejects.toThrow("unloading");
  });
  test("unload during allocation cleans up the returned ID", async () => {
    const { storage, config } = fixture(false);
    const allocated = Promise.withResolvers<Result>();
    const started = Promise.withResolvers<void>();
    const calls: string[][] = [];
    const cli = new CLI(async (args) => {
      calls.push(args);
      if (args.includes("create")) {
        started.resolve();
        return allocated.promise;
      }
      if (args.includes("get")) throw new Error("cancelled");
      return result({});
    });
    const runtime = new Runtime(cli, config, "/project", storage);
    const pending = runtime.ensure("a").then(
      () => undefined,
      (error) => error,
    );
    await started.promise;
    const closing = runtime.close();
    allocated.resolve(result({ id: "late-box" }));
    expect(await pending).toBeInstanceOf(Error);
    await closing;
    expect(calls.some((args) => args.includes("rm") && args.includes("late-box"))).toBe(true);
  });
  test("failed cleanup propagates and retains durable ownership", async () => {
    const { runtime, cli, entries } = fixture();
    await runtime.ensure("a");
    cli.destroy = async () => {
      throw new Error("control plane unavailable");
    };
    await expect(runtime.release("a", true)).rejects.toThrow("unavailable");
    expect(entries.size).toBe(1);
    await runtime.close();
  });
});
