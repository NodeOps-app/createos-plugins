import { expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import plugin from "./plugin.ts";
import { CreateOS } from "./rpc.ts";

type Failure = { type: string; message: string; data: unknown };
const context = {
  signal: new AbortController().signal,
  error: (type: string, message: string, data: unknown): Failure => ({ type, message, data }),
};
type Handler = (input: unknown, ctx: typeof context) => Promise<unknown>;

async function fixture(
  options: {
    directory?: string;
    missing?: boolean;
    get?: () => Promise<unknown>;
  } = {},
) {
  let handlers!: Record<string, Handler>;
  let reads = 0;
  let removals = 0;
  const cleanup = await plugin.setup({
    options: { persist: true },
    location: { directory: "/project" },
    storage: {
      get: async () => {
        reads++;
        return options.get?.();
      },
      remove: async () => {
        removals++;
      },
    },
    tool: { transform: async () => {} },
    command: { transform: async () => {} },
    session: {
      hook: async () => {},
      get: async () => {
        if (options.missing) throw new Error("Session not found");
        return { location: { directory: options.directory ?? "/project" } };
      },
    },
    rpc: {
      register: async (_definition: unknown, implementation: Record<string, Handler>) => {
        handlers = implementation;
      },
    },
  } as unknown as Plugin.Context);
  return {
    call: (method: string, input: unknown) => handlers[method]!(input, context),
    cleanup,
    reads: () => reads,
    removals: () => removals,
  };
}

test("release declares the error data emitted by the registered handler", () => {
  expect(CreateOS.methods.release.errors.release_failed).toEqual({
    type: "object",
    properties: { sessionID: { type: "string", minLength: 1 }, destroy: { type: "boolean" } },
    required: ["sessionID", "destroy"],
    additionalProperties: false,
  });
  for (const method of [CreateOS.methods.release, CreateOS.methods.status]) {
    expect(Object.keys(method.errors)).toContain("session_unavailable");
    expect(Object.keys(method.errors)).toContain("location_mismatch");
  }
});

test("external ownership refusal remains actionable and forget succeeds", async () => {
  const f = await fixture({ get: async () => ({ id: "external-box", owned: false }) });
  try {
    expect(await f.call("release", { sessionID: "session", destroy: true })).toEqual({
      type: "release_failed",
      message: "Cannot automatically destroy an externally owned sandbox",
      data: { sessionID: "session", destroy: true },
    });
    expect(f.removals()).toBe(0);
    expect(await f.call("release", { sessionID: "session", destroy: false })).toEqual({
      released: true,
    });
    expect(f.removals()).toBe(1);
  } finally {
    await f.cleanup?.();
  }
});

test("a concurrent release reports the runtime refusal without clearing the binding twice", async () => {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<undefined>();
  const f = await fixture({
    get: async () => {
      entered.resolve();
      return gate.promise;
    },
  });
  const first = f.call("release", { sessionID: "session", destroy: false });
  try {
    await entered.promise;
    expect(await f.call("release", { sessionID: "session", destroy: false })).toEqual({
      type: "release_failed",
      message: "Session sandbox is already being released",
      data: { sessionID: "session", destroy: false },
    });
    expect(f.removals()).toBe(0);
    gate.resolve(undefined);
    expect(await first).toEqual({ released: true });
    expect(f.removals()).toBe(1);
  } finally {
    gate.resolve(undefined);
    await first;
    await f.cleanup?.();
  }
});

test("release failures preserve their message and request context", async () => {
  const f = await fixture({
    get: async () => {
      throw new Error("Storage unavailable; retry later");
    },
  });
  try {
    expect(await f.call("release", { sessionID: "session", destroy: true })).toEqual({
      type: "release_failed",
      message: "Storage unavailable; retry later",
      data: { sessionID: "session", destroy: true },
    });
    expect(f.removals()).toBe(0);
  } finally {
    await f.cleanup?.();
  }
});

for (const method of ["status", "release"]) {
  for (const [options, type] of [
    [{ missing: true }, "session_unavailable"],
    [{ directory: "/other-project" }, "location_mismatch"],
  ] as const) {
    test(`${method} rejects ${type} before accessing sandbox ownership`, async () => {
      const f = await fixture(options);
      try {
        await expect(f.call(method, { sessionID: "session", destroy: true })).rejects.toMatchObject(
          {
            type,
            message: expect.any(String),
            data: { sessionID: "session" },
          },
        );
        expect(f.reads()).toBe(0);
        expect(f.removals()).toBe(0);
      } finally {
        await f.cleanup?.();
      }
    });
  }
}
