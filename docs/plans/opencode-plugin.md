# OpenCode Plugin Plan — `@createos/opencode`

> Route all OpenCode built-in tools to a remote CreateOS Sandbox, mirroring the
> Pi extension (`feat/pi`) but adapted to OpenCode's plugin API.

## 1. Architecture Overview

```
packages/opencode-plugin/
├── index.ts              # Plugin entry point (Plugin function)
├── package.json          # npm: @createos/opencode
├── tsconfig.json
├── CLAUDE.md             # Architecture notes for AI assistants
└── src/
    ├── cli.ts            # Thin wrappers around `createos` CLI (port from Pi)
    ├── tools.ts          # 33 tool registrations using tool() + tool.schema.*
    ├── hooks.ts          # Lifecycle hooks (session, shell.env, tool.execute.*)
    └── util.ts           # shellQuote, shortId, joinPath helpers
```

### Key Design Decisions

| Decision                                             | Rationale                                                                                                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CLI-only** (no HTTP client)                        | Same as Pi — shells out to `createos` CLI via `$` (Bun shell). Zero maintenance when CLI adds features.                                                   |
| **Same-name tool override**                          | OpenCode plugin tools with same name as built-ins take precedence. We override: `bash`, `read`, `write`, `edit`, `ls`, `find`, `grep`.                    |
| **`session.created` + `session.idle`** for lifecycle | No direct `session_start`/`session_shutdown` like Pi — use OpenCode's event system.                                                                       |
| **No ops.ts**                                        | Pi needed `*Operations` interfaces to plug into its tool factories. OpenCode tools are self-contained — CLI calls go directly in each tool's `execute()`. |
| **No flag system**                                   | Pi used `pi.registerFlag('createos')`. OpenCode uses plugin config in `opencode.json` or `CREATEOS_ENABLED` env var.                                      |

## 2. API Mapping: Pi Extension → OpenCode Plugin

| Pi Extension                                                       | OpenCode Plugin                                               | Notes                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------- |
| `export default function(pi)`                                      | `export const CreateOS: Plugin = async (ctx) => {}`           | Different entry point signature          |
| `pi.registerTool({ name, parameters: Type.Object(...), execute })` | `tool({ description, args: { ... tool.schema.* }, execute })` | TypeBox → tool.schema (Zod-like)         |
| `pi.exec('createos', args)`                                        | `ctx.$\`createos ${args}\``                                   | Bun shell API                            |
| `pi.registerFlag('createos')`                                      | `opencode.json` config or env var                             | No flag registration in OpenCode         |
| `pi.registerCommand('sandbox', { handler })`                       | Not directly supported — use TUI command hook or tool         | OpenCode has `tui.command.execute` event |
| `pi.getFlag('createos')`                                           | `process.env.CREATEOS_ENABLED` or config check                |                                          |
| `pi.session.get(key)` / `pi.session.set(key)`                      | File-based state or in-memory Map                             | No session storage API in OpenCode       |
| Signal/abort handling                                              | `context` parameter in `execute()`                            |                                          |

## 3. Phased Implementation

### Phase 1: Scaffold + CLI Layer (port cli.ts + util.ts)

**Files:** `index.ts`, `src/cli.ts`, `src/util.ts`, `package.json`, `tsconfig.json`

Port `cli.ts` from Pi, replacing `pi.exec()` calls with Bun shell (`$`):

```typescript
// Pi version:
async function run(pi: ExtensionAPI, args: string[]): Promise<ExecResult> {
  const res = await pi.exec("createos", args);
  return { code: res.code, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// OpenCode version:
async function run($: BunShell, args: string[]): Promise<ExecResult> {
  const res = await $`createos ${args}`.quiet();
  return {
    code: res.exitCode,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  };
}
```

Functions to port (all 20+):

- `createSandbox`, `getSandbox`, `destroySandbox`, `pauseSandbox`, `resumeSandbox`
- `listSandboxes`, `forkSandbox`, `editSandbox`, `sandboxExec`
- `pushFile`, `pullFile`, `startTunnel`, `getPreviewUrl`
- `createNetwork`, `listNetworks`, `getNetwork`, `deleteNetwork`, `attachNetwork`, `detachNetwork`
- `createDisk`, `listDisks`, `getDisk`, `deleteDisk`, `attachDisk`, `detachDisk`
- `registerDevice`, `deviceStatus`, `vpnUp`, `deviceAttach`, `deviceDetach`
- `listShapes`, `listRootfs`, `getBandwidth`
- `autoInstallCLI`, `cleanupTempKey`

### Phase 2: Built-in Tool Overrides (7 tools)

Override OpenCode's built-in tools by registering tools with the same names:

```typescript
// Example: bash tool override
bash: tool({
  description: "Run a shell command in the CreateOS sandbox",
  args: {
    command: tool.schema.string().describe("The command to run"),
    timeout: tool.schema.number().optional().describe("Timeout in ms"),
  },
  async execute(args, context) {
    const active = getActive()
    if (!active) return fallbackLocal(args, context)
    const res = await cli.sandboxExec($, active.sandboxId, args.command)
    return res.stdout || "(no output)"
  },
}),
```

Tools to override:

1. **bash** — route shell commands to sandbox via `createos sandbox exec`
2. **read** — pull file content via `createos sandbox pull`
3. **write** — push file content via `createos sandbox push`
4. **edit** — pull → apply edit → push
5. **ls** — `createos sandbox exec 'ls -1A <path>'`
6. **find** — remote find/rg via exec
7. **grep** — remote grep/rg via exec

### Phase 3: Sandbox-Specific Tools (26 tools)

Port all sandbox tools, converting TypeBox schemas to `tool.schema.*`:

```typescript
// Pi (TypeBox):
parameters: Type.Object({
  shape: Type.Optional(Type.String({ description: '...' })),
  rootfs: Type.Optional(Type.String({ description: '...' })),
})

// OpenCode (tool.schema):
args: {
  shape: tool.schema.string().optional().describe('...'),
  rootfs: tool.schema.string().optional().describe('...'),
}
```

**Lifecycle (8):** sandbox_create, sandbox_exec, sandbox_info, sandbox_list, sandbox_pause, sandbox_resume, sandbox_fork, sandbox_destroy

**Config (5):** sandbox_ingress, sandbox_firewall, sandbox_bandwidth, sandbox_shapes, sandbox_images

**Ports & Sync (3):** sandbox_preview_url, sandbox_tunnel, sandbox_sync

**Networks (6):** sandbox_network_create, sandbox_network_list, sandbox_network_show, sandbox_network_attach, sandbox_network_detach, sandbox_network_delete

**Disks (6):** sandbox_disk_create, sandbox_disk_list, sandbox_disk_show, sandbox_disk_delete, sandbox_disk_attach, sandbox_disk_detach

**Device VPN (5):** sandbox_device_register, sandbox_device_status, sandbox_vpn_up, sandbox_device_attach, sandbox_device_detach (note: VPN returns advisory command, same as Pi)

### Phase 4: Lifecycle Hooks

```typescript
export const CreateOS: Plugin = async ({ project, client, $, directory }) => {
  let active: ActiveSandbox | null = null;

  // Auto-create sandbox on session start
  const sandbox = await cli.createSandbox($, {
    shape: process.env.CREATEOS_SHAPE ?? "s-2vcpu-2gb",
    rootfs: process.env.CREATEOS_ROOTFS,
    ingress: true,
  });
  active = { sandboxId: sandbox.id, cwd: "/root" };

  await client.app.log({
    body: {
      service: "createos",
      level: "info",
      message: `Sandbox ready: ${sandbox.id}`,
    },
  });

  return {
    // Inject env vars for CLI auth
    "shell.env": async (input, output) => {
      if (process.env.CREATEOS_API_KEY) {
        output.env.CREATEOS_API_KEY = process.env.CREATEOS_API_KEY;
      }
    },

    // Cleanup on idle (optional — sandbox auto-destroys)
    event: async ({ event }) => {
      if (event.type === "session.deleted" && active) {
        await cli.destroySandbox($, active.sandboxId);
        active = null;
      }
    },

    tool: {/* ... all 33 tools ... */},
  };
};
```

### Phase 5: Configuration & Distribution

**`package.json`:**

```json
{
  "name": "@createos/opencode",
  "version": "0.1.0",
  "type": "module",
  "main": "index.ts",
  "dependencies": {
    "@opencode-ai/plugin": "latest"
  },
  "files": ["index.ts", "src", "README.md"]
}
```

**User installs via `opencode.json`:**

```json
{
  "plugin": ["@createos/opencode"]
}
```

**Environment variables (configuration):**

| Var                 | Default                     | Description                               |
| ------------------- | --------------------------- | ----------------------------------------- |
| `CREATEOS_ENABLED`  | `true` (when plugin loaded) | Disable to fall back to local tools       |
| `CREATEOS_SHAPE`    | `s-2vcpu-2gb`               | Sandbox shape                             |
| `CREATEOS_ROOTFS`   | `devbox:1`                  | Base image                                |
| `CREATEOS_NETWORKS` | (none)                      | Comma-separated network names to join     |
| `CREATEOS_API_KEY`  | (none)                      | API key (alternative to `createos login`) |

## 4. What Changes vs. Pi Extension

| Aspect            | Pi Extension                                              | OpenCode Plugin                                                    |
| ----------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| Entry point       | `export default function(pi)`                             | `export const CreateOS: Plugin = async (ctx) => {}`                |
| Schema lib        | TypeBox (`Type.Object`, `Type.String`)                    | `tool.schema.*` (Zod-like)                                         |
| Shell exec        | `pi.exec('createos', args)`                               | `$\`createos ...\`` (Bun shell)                                    |
| Flags             | `pi.registerFlag()` / `pi.getFlag()`                      | Env vars                                                           |
| Commands          | `pi.registerCommand()`                                    | Not needed (tools are sufficient)                                  |
| Session state     | `pi.session.get/set`                                      | In-memory + filesystem                                             |
| Ops layer         | Required (`*Operations` interfaces)                       | Not needed — direct CLI calls in `execute()`                       |
| Tool registration | `pi.registerTool({ name, parameters, execute })`          | `tool({ description, args, execute })` returned in `tool:` map     |
| Lifecycle         | `session_start`, `before_agent_start`, `session_shutdown` | `session.created` event, `shell.env` hook, `session.deleted` event |

## 5. Reuse from Pi Extension

**Direct port (adapt syntax only):**

- `src/cli.ts` — all 30+ CLI wrapper functions (change `pi.exec` → `$`)
- `src/util.ts` — `shellQuote`, `shortId`, `joinPath` (identical)
- Tool descriptions, promptGuidelines text — copy verbatim
- Error handling patterns (`CLIError` class)

**Rewrite needed:**

- `index.ts` — completely different plugin shape
- `src/tools.ts` — same logic, different registration API
- `src/ops.ts` — eliminated (operations folded into tool execute functions)
- `src/find-tool.ts`, `src/grep-tool.ts` — logic reused, but inline in tool definitions

## 6. Estimated Scope

| Component                        | Lines (est.) | Effort                             |
| -------------------------------- | ------------ | ---------------------------------- |
| `src/cli.ts`                     | ~400         | Port from Pi (syntax changes only) |
| `src/util.ts`                    | ~15          | Copy from Pi                       |
| `src/tools.ts`                   | ~700         | Rewrite tool registrations         |
| `src/hooks.ts`                   | ~80          | New (lifecycle, shell.env)         |
| `index.ts`                       | ~100         | New (plugin entry, sandbox boot)   |
| `package.json` + `tsconfig.json` | ~30          | New                                |
| **Total**                        | **~1,325**   | **~75% port, ~25% new**            |

Compared to Pi's ~5,500 lines: significantly smaller because we eliminate the ops layer, command system, and flag infrastructure. OpenCode's simpler plugin API means less boilerplate.

## 7. Open Questions

1. **Sandbox cleanup on exit** — OpenCode's `session.deleted` event fires after the session is gone. Is there a pre-delete hook? If not, rely on sandbox TTL auto-destroy.
2. **Slash commands** — Pi had `/sandbox`, `/network`, `/device`. OpenCode doesn't have a direct equivalent. Options: (a) skip, tools are sufficient; (b) use `tui.command.execute` hook to intercept custom commands.
3. **File sync (Mutagen)** — Pi extension managed temp SSH keys. Do we want sync for OpenCode, or is pull/push-per-file sufficient? Recommend deferring sync to Phase 2 release.
4. **`experimental.session.compacting`** — inject sandbox context during compaction so the LLM remembers the sandbox after context truncation? Likely yes.
