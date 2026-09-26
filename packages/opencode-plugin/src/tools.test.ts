import { test, expect } from "bun:test";
import type { Info, ToolEditor, ToolContext } from "@opencode/plugin/promise/tool";
import type { Plugin } from "@opencode/plugin";
import { configure } from "./config.ts";
import { CLI } from "./cli.ts";
import { Runtime } from "./runtime.ts";
import { Files } from "./files.ts";
import { Background } from "./background.ts";
import { registerTools, routeTools } from "./tools.ts";
import plugin from "./plugin.ts";

function editorFor(tools: Map<string, Info>): ToolEditor {
  return {
    list: () => [...tools].map(([id, tool]) => ({ ...tool, id })),
    get: (id) => {
      const tool = tools.get(id);
      return tool ? { ...tool, id } : undefined;
    },
    add: (tool) => {
      tools.set(
        tool.options?.namespace ? `${tool.options.namespace}_${tool.name}` : tool.name,
        tool,
      );
    },
    update: (id, update) => {
      const tool = tools.get(id);
      if (tool) update(tool);
    },
    remove: (id) => {
      tools.delete(id);
    },
    namespace: () => {},
  };
}
const context = { sessionID: "session", signal: new AbortController().signal } as ToolContext;
test("local mode preserves native execution/content/metadata without undeclared output", async () => {
  let calls = 0;
  const schema = { type: "object" as const };
  const input = { command: "hello" };
  const nativeResult = {
    content: "local",
    metadata: { exitCode: 0, jobID: "native-job" },
    output: { output: "local", truncated: false },
  };
  const tools = new Map<string, Info>([
    [
      "shell",
      {
        name: "shell",
        description: "native shell",
        input: schema,
        output: { type: "object", required: ["output", "truncated"] },
        execute: async (args, ctx) => {
          calls++;
          expect(args).toBe(input);
          expect(ctx).toBe(context);
          return nativeResult;
        },
      },
    ],
  ]);
  const runtime = new Runtime(
    new CLI(),
    configure({}, {}),
    "/project",
    {} as Plugin.Context["storage"],
  );
  routeTools(editorFor(tools), runtime, new Files(runtime.cli));
  const result = await tools.get("shell")!.execute(input, context);
  expect(result).toEqual({ content: nativeResult.content, metadata: nativeResult.metadata });
  expect(Object.hasOwn(result, "output")).toBe(false);
  expect(nativeResult.output).toEqual({ output: "local", truncated: false });
  expect(result).not.toBe(nativeResult);
  expect(tools.get("shell")!.input).toBe(schema);
  expect(tools.get("shell")!.output).toBeUndefined();
  expect(calls).toBe(1);
});
test("remote mode returns content and metadata under the wrapper's schema-free output contract", async () => {
  let localCalls = 0;
  const tools = new Map<string, Info>([
    [
      "shell",
      {
        name: "shell",
        description: "native shell",
        input: { type: "object" },
        output: { type: "object", required: ["nativeJobID"] },
        execute: async () => {
          localCalls++;
          return { content: "local", output: { nativeJobID: "host-job" } };
        },
      },
    ],
  ]);
  const runtime = new Runtime(
    new CLI(),
    configure({ mode: "remote" }, {}),
    "/project",
    {} as Plugin.Context["storage"],
  );
  const remoteResult = {
    stdout: "guest result",
    stderr: "",
    code: 0,
    truncated: false,
    processId: "guest-process",
  };
  runtime.ensure = async () => ({ id: "box", cwd: "/work", source: "/project", owned: true });
  let remoteCalls = 0;
  runtime.cli.execute = async (id, command, cwd) => {
    remoteCalls++;
    expect({ id, command, cwd }).toEqual({ id: "box", command: "hello", cwd: "/work" });
    return remoteResult;
  };
  routeTools(editorFor(tools), runtime, new Files(runtime.cli));
  const tool = tools.get("shell")!;
  const result = await tool.execute({ command: "hello" }, context);
  expect(result).toEqual({
    content: JSON.stringify(remoteResult),
    metadata: { sandboxId: "box", exitCode: 0 },
  });
  expect(Object.hasOwn(result, "output")).toBe(false);
  expect(tool.output).toBeUndefined();
  expect(remoteCalls).toBe(1);
  expect(localCalls).toBe(0);
  runtime.cli.execute = async () => {
    throw new Error("remote execution failed");
  };
  await expect(tool.execute({ command: "hello" }, context)).rejects.toThrow(
    "remote execution failed",
  );
  expect(localCalls).toBe(0);
});
test("selected remote mode never falls back to local execution on failure", async () => {
  let calls = 0;
  const tools = new Map<string, Info>([
    [
      "shell",
      {
        name: "shell",
        description: "shell",
        input: { type: "object" },
        execute: async () => {
          calls++;
          return { content: "local" };
        },
      },
    ],
  ]);
  const runtime = new Runtime(
    new CLI(),
    configure({ mode: "remote" }, {}),
    "/project",
    {} as Plugin.Context["storage"],
  );
  runtime.ensure = async () => {
    throw new Error("remote unavailable");
  };
  routeTools(editorFor(tools), runtime, new Files(runtime.cli));
  await expect(tools.get("shell")!.execute({ command: "hello" }, context)).rejects.toThrow(
    "remote unavailable",
  );
  expect(calls).toBe(0);
});
test("catalog includes lifecycle, files, jobs, transports and managed processes", () => {
  const tools = new Map<string, Info>();
  const runtime = new Runtime(
    new CLI(),
    configure({}, {}),
    "/project",
    {} as Plugin.Context["storage"],
  );
  registerTools(editorFor(tools), runtime, new Files(runtime.cli), new Background());
  for (const name of [
    "sandbox_create",
    "sandbox_offload",
    "sandbox_fanout",
    "sandbox_patch",
    "sandbox_sync",
    "sandbox_process_start",
    "sandbox_process_stop",
    "sandbox_screenshot",
    "sandbox_disk_create",
  ])
    expect(tools.has(name)).toBe(true);
  expect(tools.size).toBe(54);
});
test("V2 setup registers tools, commands, a context hook and RPC without provisioning", async () => {
  const tools = new Map<string, Info>();
  const commands: string[] = [],
    hooks: string[] = [],
    rpcs: string[] = [];
  const ctx = {
    options: {},
    location: { directory: "/project" },
    storage: {},
    tool: {
      transform: async (callback: (editor: ToolEditor) => void) => callback(editorFor(tools)),
    },
    session: {
      hook: async (name: string) => {
        hooks.push(name);
      },
    },
    command: {
      transform: async (callback: (editor: { add: (command: { name: string }) => void }) => void) =>
        callback({
          add: (command) => {
            commands.push(command.name);
          },
        }),
    },
    rpc: {
      register: async (definition: { id: string }) => {
        rpcs.push(definition.id);
      },
    },
  } as unknown as Plugin.Context;
  const cleanup = await plugin.setup(ctx);
  expect(hooks).toEqual(["context"]);
  expect(commands).toEqual(["sandbox", "sandbox-release"]);
  expect(rpcs).toEqual(["createos"]);
  expect(typeof cleanup).toBe("function");
  await cleanup?.();
});
