import type { ToolEditor, ToolContext } from "@opencode/plugin/promise/tool";
import type { JsonSchema } from "effect";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { identifier, record } from "./cli.ts";
import { Runtime } from "./runtime.ts";
import { Files, remotePath } from "./files.ts";
import { Background } from "./background.ts";
import { job, fanout } from "./jobs.ts";
import { stage } from "./sync.ts";
import { object, text, integer } from "./util.ts";

type Schema = JsonSchema.JsonSchema;
const string: Schema = { type: "string" };
const boolean: Schema = { type: "boolean" };
const number: Schema = { type: "integer", minimum: 1 };
const strings: Schema = { type: "array", items: string };
const sid = { sandbox_id: string };
export function schema(properties: Record<string, Schema>, required: string[] = []): Schema {
  return { type: "object", properties, required, additionalProperties: false };
}

export function registerTools(
  editor: ToolEditor,
  runtime: Runtime,
  files: Files,
  background: Background,
): void {
  const cli = runtime.cli;
  editor.namespace({
    name: "sandbox",
    description:
      "CreateOS remote Linux execution, sandboxes, files, networks, disks, desktop and managed processes.",
  });
  function add(
    name: string,
    description: string,
    properties: Record<string, Schema>,
    required: string[],
    execute: (
      args: Record<string, unknown>,
      context: ToolContext,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {
    editor.add({
      name,
      description,
      input: schema(properties, required),
      options: { namespace: "sandbox", codemode: true },
      execute: (input, context) =>
        runtime.task(context.sessionID, context.signal, async (signal) => {
          const result = await execute(object(input), context, signal);
          return { content: typeof result === "string" ? result : JSON.stringify(result, null, 2) };
        }),
    });
  }
  const target = async (
    args: Record<string, unknown>,
    context: ToolContext,
    signal: AbortSignal,
  ) =>
    args.sandbox_id === undefined
      ? (await runtime.ensure(context.sessionID, signal)).id
      : identifier(args.sandbox_id);
  add(
    "status",
    "Show this session's remote mode, sandbox and local transports.",
    {},
    [],
    async (_, context) => ({ ...runtime.status(context.sessionID), transports: background.list() }),
  );
  add(
    "create",
    "Create an independent sandbox. The returned sandbox persists until explicitly destroyed.",
    { shape: string, rootfs: string, name: string, network: string },
    [],
    async (args, _, signal) => {
      const id = await cli.create(
        {
          ...runtime.config,
          shape: text(args.shape, "shape", runtime.config.shape),
          rootfs: text(args.rootfs, "rootfs", runtime.config.rootfs),
          name: args.name === undefined ? undefined : identifier(args.name),
          network: args.network === undefined ? runtime.config.network : identifier(args.network),
        },
        signal,
      );
      try {
        signal.throwIfAborted();
        await cli.ready(id, signal);
        return { sandbox_id: id };
      } catch (error) {
        try {
          await cli.destroy(id);
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], `Sandbox ${id} remains allocated`);
        }
        throw error;
      }
    },
  );
  for (const [name, verb, description] of [
    ["info", "get", "Inspect a sandbox"],
    ["pause", "pause", "Pause a sandbox"],
    ["resume", "resume", "Resume a sandbox"],
    ["fork", "fork", "Fork a sandbox into an independent copy"],
  ])
    add(
      name,
      description + ". Omit sandbox_id to use the session sandbox.",
      sid,
      [],
      async (args, context, signal) =>
        cli.json(["sandbox", verb, await target(args, context, signal)], { signal }),
    );
  for (const [name, verb] of [
    ["list", "list"],
    ["shapes", "shapes"],
    ["images", "rootfs"],
  ]) {
    add(name, `List CreateOS ${name}.`, {}, [], async (_, __, signal) =>
      cli.json(["sandbox", verb], { signal }),
    );
  }
  add(
    "destroy",
    "Permanently destroy an explicitly identified sandbox.",
    sid,
    ["sandbox_id"],
    async (args, context) => {
      await runtime.destroyExplicit(identifier(args.sandbox_id), context.sessionID);
      return { destroyed: args.sandbox_id };
    },
  );
  add(
    "exec",
    "Run a command through a reconnectable managed process. Timeout or cancellation stops its remote process tree. Omit sandbox_id to use the session sandbox.",
    { ...sid, command: string, cwd: string, timeout: number },
    ["command"],
    async (args, context, signal) => {
      const id = await target(args, context, signal);
      return cli.execute(
        id,
        text(args.command, "command"),
        text(args.cwd, "cwd", args.sandbox_id ? "/root" : runtime.config.cwd),
        integer(args.timeout, "timeout", runtime.config.timeout),
        signal,
      );
    },
  );
  const jobProperties = {
    command: string,
    dir: string,
    shape: string,
    rootfs: string,
    timeout: number,
    out: string,
    keep_on_fail: boolean,
  };
  add(
    "offload",
    "Copy a project to a fresh sandbox, run a command, optionally retrieve one artifact file, then destroy. Failed artifact retrieval or uncertain execution retains the sandbox for recovery.",
    jobProperties,
    ["command"],
    (args, _, signal) => job(cli, runtime.config, runtime.source, args, signal),
  );
  add(
    "run_code",
    "Execute one program in a disposable sandbox. Languages: py, js, mjs, cjs, ts, sh, go, rb, c, cpp, rs. Returns stdout, stderr and exit code.",
    { code: string, lang: string, stdin: string, timeout: number, shape: string, rootfs: string },
    ["code", "lang"],
    (args, _, signal) => job(cli, runtime.config, runtime.source, args, signal),
  );
  add(
    "fanout",
    "Run commands against independent copies of the project with bounded concurrency. Each result includes its sandbox ID and retention state.",
    {
      commands: strings,
      dir: string,
      jobs: number,
      shape: string,
      rootfs: string,
      timeout: number,
      keep_on_fail: boolean,
    },
    ["commands"],
    (args, _, signal) => fanout(cli, runtime.config, runtime.source, args, signal),
  );
  for (const [name, properties, required] of [
    ["read", { path: string, offset: number, limit: number }, ["path"]],
    ["write", { path: string, content: string }, ["path", "content"]],
    [
      "edit",
      { path: string, oldString: string, newString: string, replaceAll: boolean },
      ["path", "oldString", "newString"],
    ],
    ["patch", { patchText: string }, ["patchText"]],
    ["glob", { pattern: string, path: string, hidden: boolean, limit: number }, ["pattern"]],
    [
      "grep",
      {
        pattern: string,
        path: string,
        include: string,
        literal: boolean,
        caseSensitive: boolean,
        limit: number,
      },
      ["pattern"],
    ],
  ] as [string, Record<string, Schema>, string[]][]) {
    add(
      name,
      name === "patch"
        ? "Apply an exact text patch inside the session sandbox. Paths are relative to its working directory. " +
            "patchText must use *** Begin Patch and *** End Patch lines, not unified diff headers. " +
            "Use *** Add File: path with + prefixed lines, *** Delete File: path, or *** Update File: path " +
            "with @@ hunks containing space-prefixed context, - removals and + additions. " +
            "An update may include *** Move to: path. Example:\n*** Begin Patch\n*** Add File: src/new.txt\n+hello\n*** End Patch"
        : `${name} files inside the session sandbox. Paths relative to its working directory.`,
      properties,
      required,
      async (args, context, signal) =>
        files.execute(await runtime.ensure(context.sessionID, signal), name, args, signal),
    );
  }
  add(
    "push",
    "Upload a local file to an explicitly selected sandbox.",
    { ...sid, local_path: string, remote_path: string },
    ["sandbox_id", "local_path", "remote_path"],
    async (args, _, signal) => {
      const local = resolve(runtime.source, text(args.local_path, "local_path"));
      await cli.checked(
        [
          "sandbox",
          "push",
          identifier(args.sandbox_id),
          local,
          text(args.remote_path, "remote_path"),
        ],
        { signal, timeout: 600_000 },
      );
      return { uploaded: local };
    },
  );
  add(
    "pull",
    "Download a sandbox file to the specified local path.",
    { ...sid, local_path: string, remote_path: string },
    ["sandbox_id", "local_path", "remote_path"],
    async (args, _, signal) => {
      const local = resolve(runtime.source, text(args.local_path, "local_path"));
      await cli.checked(
        [
          "sandbox",
          "pull",
          identifier(args.sandbox_id),
          text(args.remote_path, "remote_path"),
          local,
        ],
        { signal, timeout: 600_000 },
      );
      return { downloaded: local };
    },
  );
  add(
    "sync",
    "Copy a local project once or start an explicit one-way/two-way watcher. Returns a local transport ID for watchers.",
    {
      ...sid,
      local_dir: string,
      remote_dir: string,
      mode: { enum: ["once", "one-way", "two-way"] },
    },
    ["sandbox_id", "local_dir", "remote_dir"],
    async (args, _, signal) => {
      const local = await realpath(resolve(runtime.source, text(args.local_dir, "local_dir")));
      if (
        local === "/" ||
        local === homedir() ||
        local.startsWith(homedir() + "/.config") ||
        local.startsWith(homedir() + "/.ssh")
      )
        throw new Error("Sync source must be a project directory");
      const id = identifier(args.sandbox_id),
        remote = text(args.remote_dir, "remote_dir"),
        mode = text(args.mode, "mode", "once");
      if (!isAbsolute(remote)) throw new Error("remote_dir must be absolute");
      if (mode === "once") {
        await stage(cli, id, local, remote, signal);
        return { synced: true };
      }
      if (!["one-way", "two-way"].includes(mode)) throw new Error("Unsupported sync mode");
      await cli.ready(id, signal);
      return {
        transport_id: await background.watch(id, local, remote, mode),
        status: "started; inspect transport status for process liveness",
      };
    },
  );
  add(
    "tunnel",
    "Start a private localhost port forward. Stop it using transport_stop.",
    { ...sid, remote_port: number, local_port: number },
    ["sandbox_id", "remote_port"],
    async (args, _, signal) => {
      const id = identifier(args.sandbox_id),
        port = integer(args.remote_port, "remote_port", 3000, 65535);
      await cli.ready(id, signal);
      const local = integer(args.local_port, "local_port", port, 65535);
      return {
        transport_id: await background.start([
          "sandbox",
          "tunnel",
          "--remote",
          String(port),
          "--local",
          String(local),
          id,
        ]),
        url: `http://127.0.0.1:${local}`,
        verified: false,
      };
    },
  );
  add(
    "transport_stop",
    "Stop a plugin-owned sync watcher or tunnel.",
    { transport_id: string },
    ["transport_id"],
    async (args) => {
      await background.stop(text(args.transport_id, "transport_id"));
      return { stopped: true };
    },
  );
  add(
    "ingress",
    "Enable or disable public ingress for a sandbox.",
    { ...sid, enabled: boolean },
    ["sandbox_id", "enabled"],
    async (args, _, signal) => {
      await cli.checked(
        [
          "sandbox",
          "edit",
          identifier(args.sandbox_id),
          "--ingress",
          args.enabled === true ? "on" : "off",
        ],
        { signal },
      );
      return { enabled: args.enabled };
    },
  );
  add(
    "preview_url",
    "Return a sandbox's configured public URL for a port. This does not enable ingress or claim that its service is healthy.",
    { ...sid, port: number },
    ["sandbox_id", "port"],
    async (args, _, signal) => {
      const info = record(
        await cli.json(["sandbox", "get", identifier(args.sandbox_id)], { signal }),
      );
      const template = text(info.ingress_url_template, "ingress_url_template");
      return {
        url: template.replace("<port>", String(integer(args.port, "port", 3000, 65535))),
        verified: false,
      };
    },
  );
  add(
    "firewall",
    "Set IP/CIDR egress rules. Hostname rules are unsupported because the recorded control-plane behavior does not enforce them.",
    { ...sid, rules: strings },
    ["sandbox_id", "rules"],
    async (args, _, signal) => {
      if (!Array.isArray(args.rules) || !args.rules.length)
        throw new Error("Provide at least one IP/CIDR rule");
      const rules = args.rules.map((value) => {
        const rule = text(value, "rule"),
          [address, mask] = rule.split("/");
        const version = isIP(address);
        if (
          !version ||
          rule.split("/").length > 2 ||
          (mask !== undefined && (!/^\d+$/.test(mask) || Number(mask) > (version === 4 ? 32 : 128)))
        )
          throw new Error("Only IP addresses and CIDRs are supported");
        return rule;
      });
      await cli.checked(
        [
          "sandbox",
          "edit",
          identifier(args.sandbox_id),
          ...rules.flatMap((rule) => ["--egress", rule]),
        ],
        { signal },
      );
      return { rules };
    },
  );
  for (const group of ["network", "disk"] as const) {
    for (const [action, verb] of [
      ["list", "ls"],
      ["show", "show"],
      ["delete", "rm"],
    ]) {
      add(
        `${group}_${action}`,
        `${action} a CreateOS ${group}.`,
        { name: string },
        action === "list" ? [] : ["name"],
        async (args, _, signal) => {
          const command = [
            "sandbox",
            group,
            verb,
            ...(action === "delete" ? ["--yes"] : []),
            ...(action === "list" ? [] : [identifier(args.name)]),
          ];
          if (action === "delete") {
            await cli.checked(command, { signal });
            return { deleted: args.name };
          }
          return cli.json(command, { signal });
        },
      );
    }
  }
  add(
    "network_create",
    "Create a private network.",
    { name: string },
    ["name"],
    (args, _, signal) =>
      cli.json(["sandbox", "network", "create", identifier(args.name)], { signal }),
  );
  for (const action of ["attach", "detach"]) {
    add(
      `network_${action}`,
      `${action} a sandbox or registered device to/from a network.`,
      { network: string, member: string },
      ["network", "member"],
      async (args, _, signal) => {
        await cli.checked(
          [
            "sandbox",
            "network",
            action,
            ...(action === "detach" ? ["--yes"] : []),
            identifier(args.network),
            identifier(args.member),
          ],
          { signal },
        );
        return { [action]: args.member };
      },
    );
    add(
      `disk_${action}`,
      `${action} an existing S3 disk mount.`,
      { ...sid, disk: string, mount_path: string },
      ["sandbox_id", "disk", "mount_path"],
      async (args, _, signal) => {
        await cli.checked(
          [
            "sandbox",
            "disk",
            action,
            ...(action === "detach" ? ["--yes"] : []),
            identifier(args.sandbox_id),
            identifier(args.disk),
            text(args.mount_path, "mount_path"),
          ],
          { signal },
        );
        return { [action]: args.disk };
      },
    );
  }
  add(
    "device_status",
    "List devices registered for private network access.",
    {},
    [],
    (_, __, signal) => cli.json(["sandbox", "devices", "ls"], { signal }),
  );
  add(
    "vpn_up",
    "Show the terminal command for connecting the host VPN (requires user interaction and elevated privileges).",
    {},
    [],
    async () => ({
      command: "createos sandbox vpn up",
      instructions: "Run this in your own terminal.",
    }),
  );
  add(
    "bandwidth",
    "Read sandbox bandwidth accounting when provided by the server.",
    sid,
    ["sandbox_id"],
    async (args, _, signal) => {
      const info = record(
        await cli.json(["sandbox", "get", identifier(args.sandbox_id)], { signal }),
      );
      return { bandwidth: info.bandwidth ?? null };
    },
  );
  add(
    "disk_create",
    "Create an S3 disk using credentials from named server environment variables, never from chat.",
    {
      name: string,
      bucket: string,
      endpoint: string,
      access_key_env: string,
      secret_key_env: string,
      region: string,
    },
    ["name", "bucket", "endpoint", "access_key_env", "secret_key_env"],
    async (args, _, signal) => {
      const credential = (key: string) => {
        const name = text(args[key], key);
        if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || !process.env[name])
          throw new Error(`Missing environment variable for ${key}`);
        return process.env[name]!;
      };
      return cli.json(
        [
          "sandbox",
          "disk",
          "create",
          "--bucket",
          text(args.bucket, "bucket"),
          "--endpoint",
          text(args.endpoint, "endpoint"),
          "--access-key",
          credential("access_key_env"),
          "--secret-key",
          credential("secret_key_env"),
          ...(args.region ? ["--region", text(args.region, "region")] : []),
          identifier(args.name),
        ],
        { signal },
      );
    },
  );
  add(
    "process_start",
    "Start a persistent remote command. Use process_get/output/stop to inspect and manage it.",
    { ...sid, command: string, cwd: string },
    ["sandbox_id", "command"],
    async (args, _, signal) => {
      signal.throwIfAborted();
      const id = identifier(args.sandbox_id);
      const process = record(
        await cli.json([
          "sandbox",
          "process",
          "start",
          "--cwd",
          text(args.cwd, "cwd", "/root"),
          id,
          "--",
          "bash",
          "-lc",
          text(args.command, "command"),
        ]),
      );
      const pid = identifier(process.process_id);
      if (signal.aborted) {
        await cli.checked(["sandbox", "process", "stop", "--force", id, pid]);
        signal.throwIfAborted();
      }
      return process;
    },
  );
  for (const action of ["list", "get", "stop", "output", "close-stdin"]) {
    add(
      `process_${action.replace("-", "_")}`,
      `${action} a managed process. Process identifiers are opaque strings.`,
      { ...sid, process_id: string },
      action === "list" ? ["sandbox_id"] : ["sandbox_id", "process_id"],
      async (args, _, signal) => {
        const command = [
          "sandbox",
          "process",
          action === "output" ? "attach" : action,
          ...(action === "stop" ? ["--force"] : action === "output" ? ["--no-follow"] : []),
          identifier(args.sandbox_id),
          ...(action === "list" ? [] : [identifier(args.process_id)]),
        ];
        if (action === "output" || action === "close-stdin")
          return cli.checked(command, { signal });
        return cli.json(command, { signal });
      },
    );
  }
  add(
    "process_input",
    "Send text to a persistent process's stdin.",
    { ...sid, process_id: string, text: string },
    ["sandbox_id", "process_id", "text"],
    async (args, _, signal) => {
      await cli.checked(
        [
          "sandbox",
          "process",
          "input",
          "--base64",
          Buffer.from(text(args.text, "text")).toString("base64"),
          identifier(args.sandbox_id),
          identifier(args.process_id),
        ],
        { signal },
      );
      return { sent: true };
    },
  );
  add(
    "device_register",
    "Register the host device for CreateOS private networking.",
    { name: string },
    [],
    async (args, _, signal) =>
      (
        await cli.checked(
          [
            "sandbox",
            "devices",
            "register",
            ...(args.name ? ["--name", identifier(args.name)] : []),
          ],
          { signal },
        )
      ).stdout,
  );
  add(
    "desktop",
    "Get a live noVNC desktop link. Requires a desktop image and enables ingress.",
    sid,
    ["sandbox_id"],
    (args, _, signal) =>
      cli.json(["sandbox", "desktop", identifier(args.sandbox_id)], { signal, timeout: 180_000 }),
  );
  add(
    "computer",
    "Inspect or control a sandbox desktop. Read screen bounds before using coordinates.",
    {
      ...sid,
      op: { enum: ["screen", "cursor", "windows", "move", "click", "type", "key", "open"] },
      x: { type: "integer", minimum: 0 },
      y: { type: "integer", minimum: 0 },
      text: string,
      keys: strings,
      target: string,
    },
    ["sandbox_id", "op"],
    async (args, _, signal) => {
      const op = text(args.op, "op"),
        command = ["sandbox", "computer", op, identifier(args.sandbox_id)];
      if (!["screen", "cursor", "windows", "move", "click", "type", "key", "open"].includes(op))
        throw new Error("Unsupported computer operation");
      if (op === "move" || (op === "click" && args.x !== undefined)) {
        for (const key of ["x", "y"]) {
          const value = args[key];
          if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
            throw new Error(`${key} must be nonnegative`);
          command.push(String(value));
        }
      }
      if (op === "type") command.push(text(args.text, "text"));
      if (op === "open") command.push(text(args.target, "target"));
      if (op === "key") {
        if (!Array.isArray(args.keys) || !args.keys.length) throw new Error("keys required");
        command.push(...args.keys.map((key) => text(key, "key")));
      }
      return (await cli.checked(command, { signal })).stdout;
    },
  );
  // File content is inline so remote OpenCode clients never receive a server-local screenshot path.
  editor.add({
    name: "screenshot",
    description: "Capture a sandbox desktop screenshot.",
    input: schema(sid, ["sandbox_id"]),
    options: { namespace: "sandbox", codemode: true },
    execute: (input, context) =>
      runtime.task(context.sessionID, context.signal, async (signal) => {
        const args = object(input),
          dir = await mkdtemp(join(tmpdir(), "createos-screen-"));
        try {
          const path = join(dir, "screen.png");
          await cli.checked(
            ["sandbox", "computer", "screenshot", "--out", path, identifier(args.sandbox_id)],
            { signal },
          );
          const image = await readFile(path);
          if (image.byteLength > 10 * 1024 * 1024) throw new Error("Screenshot exceeds 10 MiB");
          return {
            content: [
              {
                type: "file" as const,
                mime: "image/png",
                uri: `data:image/png;base64,${image.toString("base64")}`,
              },
            ],
          };
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
  });
}

/** Retain host input schemas/options; route execution with a content-only result contract. */
export function routeTools(editor: ToolEditor, runtime: Runtime, files: Files): void {
  const operations: Record<string, string> = {
    shell: "shell",
    bash: "shell",
    read: "read",
    write: "write",
    edit: "edit",
    patch: "patch",
    apply_patch: "patch",
    glob: "glob",
    grep: "grep",
  };
  for (const tool of editor.list()) {
    const operation = operations[tool.id];
    if (!operation) continue;
    const local = tool.execute;
    editor.update(tool.id, (draft) => {
      // Native output schemas describe host resources and shell jobs. Remote results
      // use sandbox content/metadata instead, so this dual-mode wrapper cannot
      // advertise the host-only structured output contract.
      delete draft.output;
      draft.execute = async (input, context) => {
        if (!runtime.remote(context.sessionID)) {
          // OpenCode rejects structured output without an output schema in either
          // mode. Copy the native result so its content/metadata survive without
          // mutating the original result or exposing a host-only output contract.
          const result = { ...(await local(input, context)) };
          delete result.output;
          return result;
        }
        return runtime.task(context.sessionID, context.signal, async (signal) => {
          const box = await runtime.ensure(context.sessionID, signal);
          const args = object(input);
          if (operation === "shell") {
            if (args.background === true)
              throw new Error("Use sandbox_process_start for background commands in remote mode");
            const result = await runtime.cli.execute(
              box.id,
              text(args.command, "command"),
              remotePath(text(args.workdir ?? args.cwd, "workdir", box.cwd), box),
              args.timeout === 0 ? 0 : integer(args.timeout, "timeout", runtime.config.timeout),
              signal,
            );
            return {
              content: JSON.stringify(result),
              metadata: { sandboxId: box.id, exitCode: result.code },
            };
          }
          const result = await files.execute(box, operation, args, signal);
          return {
            content: typeof result === "string" ? result : JSON.stringify(result),
            metadata: { sandboxId: box.id },
          };
        });
      };
    });
  }
}
