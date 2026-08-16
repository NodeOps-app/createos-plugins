# pi-createos-plugin

Pi coding agent extension for [CreateOS Sandbox](https://nodeops.network/createos).
Runs all tool calls inside a remote sandbox while the agent runs locally.

## Architecture

CLI-only — operations call the `createos` CLI through `pi.exec()`; the
long-lived sync watcher uses a detached Node child process so Pi does not own
its lifetime. No HTTP client, no SDK, no API keys. Auth is handled by
`createos login`.

```text
Pi agent (local)  →  createos CLI  →  CreateOS API  →  Sandbox
```

## File layout

| File               | Purpose                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `index.ts`         | Extension entry point: flags, slash commands, lifecycle hooks              |
| `src/cli.ts`       | All `createos` CLI wrappers (sandbox, network, disk, device, tunnel, sync) |
| `src/tools.ts`     | 33 registered tools, each single-purpose with `sandbox_` prefix            |
| `src/ops.ts`       | BashOps/ReadOps/WriteOps/EditOps/LsOps backed by CLI exec/push/pull        |
| `src/find-tool.ts` | Remote find via `createos sandbox exec` (rg/POSIX find fallback)           |
| `src/grep-tool.ts` | Remote grep via `createos sandbox exec` (rg/POSIX grep fallback)           |
| `src/util.ts`      | `shellQuote`, `shortId`, `joinPath`                                        |

## Pi extension best practices (enforced)

- **snake_case** tool names, all prefixed `sandbox_`
- **description** describes what the tool does, never when to use it. Preconditions
  ("the source must be paused first") belong here, not in a guideline
- **promptSnippet** is a brief one-liner for the system prompt. Every tool has one —
  it is what lists the tool in the prompt's `Available tools` section
- **promptGuidelines** only where the bullet adds signal `description` + `promptSnippet`
  cannot: cross-tool routing, preference order, or a warning. A bullet that restates the
  description is deleted — it costs tokens every turn and teaches the model nothing.
  When present, a bullet must name its tool (`"Use sandbox_xyz when..."`), because Pi
  appends all bullets flat into one `Guidelines` section with no tool prefix
- **Single-purpose tools** — no action enum parameters
- **`terminate: true`** on destructive tools (`sandbox_pause`, `sandbox_destroy`)
- **Signal handling** on built-in tool replacements (find/grep check `signal?.aborted`)
- **No background resources from factory** — all started in `session_start`
- **Cleanup in `session_shutdown`** — temp SSH key + sandbox destroy

## Tool inventory (33 tools)

### Built-in replacements (7)

`bash`, `read`, `write`, `edit`, `ls`, `find`, `grep` — transparently routed
to the sandbox when `--createos` is active, local when off.

### Sandbox lifecycle (7)

`sandbox_create`, `sandbox_exec`, `sandbox_info`, `sandbox_list`,
`sandbox_pause`, `sandbox_resume`, `sandbox_fork`, `sandbox_destroy`

### Sandbox config (5)

`sandbox_ingress`, `sandbox_firewall`, `sandbox_bandwidth`,
`sandbox_shapes`, `sandbox_images`

### Ports & sync (3)

`sandbox_preview_url`, `sandbox_tunnel`, `sandbox_sync`

### Networks (6)

`sandbox_network_create`, `sandbox_network_list`, `sandbox_network_show`,
`sandbox_network_attach`, `sandbox_network_detach`, `sandbox_network_delete`

### Disks (6)

`sandbox_disk_create`, `sandbox_disk_list`, `sandbox_disk_show`,
`sandbox_disk_delete`, `sandbox_disk_attach`, `sandbox_disk_detach`

### Device VPN (5)

`sandbox_device_register`, `sandbox_device_status`, `sandbox_vpn_up`,
`sandbox_device_attach`, `sandbox_device_detach`

## Flags

| Flag          | Type    | Purpose                                          |
| ------------- | ------- | ------------------------------------------------ |
| `--createos`  | boolean | Activate the extension                           |
| `--shape`     | string  | Sandbox size (default: `s-2vcpu-2gb`)            |
| `--rootfs`    | string  | Base image or template                           |
| `--network`   | string  | Network(s) to join at creation (comma-separated) |
| `--sync-once` | boolean | Copy the host project to `/root/workspace` first |
| `--watch`     | boolean | Keep the host project and sandbox synchronized   |

`--sync-once` and `--watch` are mutually exclusive. The first packs and uploads
host files without VCS metadata; the second delegates to the existing two-way
`createos sandbox sync` command.

## Slash commands

| Command                 | Purpose                                             |
| ----------------------- | --------------------------------------------------- |
| `/sandbox`              | Show active sandbox status                          |
| `/network <sub> [args]` | Network CRUD (create, ls, show, rm, attach, detach) |
| `/device <sub> [args]`  | Device status, attach, detach                       |

## Lifecycle

1. `session_start` — preflight checks, create sandbox, then optionally sync or watch `/root/workspace`
2. `before_agent_start` — inject sandbox context into system prompt
3. `session_shutdown` — stop a watcher, clean up temp SSH key, destroy sandbox (ephemeral) or keep (persisted)

## CLI JSON support

Commands that return structured data must use `-o json`. The CLI auto-detects
non-TTY but Pi's `pi.exec()` may allocate a PTY, so we force `-o json` explicitly.

Commands that don't support `-o json` (create, network create, disk create, fork)
were patched in `createos-cli` to support it via `output.Render()`.

## Key design decisions

- **CLI-only**: Zero HTTP client. The `createos` CLI handles auth, retries, and
  all API complexity. Extension maintenance is near-zero — new CLI features
  work automatically.

- **Temp SSH key for sync**: `sandbox_sync` uses Mutagen which needs SSH.
  The user's key may be passphrase-protected (can't prompt non-interactively).
  We generate a throwaway ed25519 key per session, cleaned up on shutdown.
  For `--watch`, the watcher gets its own key (held on `ProjectWatch`),
  cleaned on every shutdown path (`quit`/`new`/`resume`/`fork`) to avoid
  orphans.

- **Detached spawn for the watch process**: `createos sandbox sync` is a
  long-lived foreground process. Do NOT launch it via `pi.exec("sh", ["-c",
"nohup ... & echo $!"])` — Pi's `exec` allocates a PTY, and the backgrounded
  `nohup` process loses its controlling terminal and dies before Mutagen can
  establish a sync session (sandbox stays unsynced, silently). Instead,
  `startDetached` spawns it directly as a detached Node child
  (`spawn("createos", args, { detached: true, stdio: "ignore" })` then
  `child.unref()`), so Pi's event loop can exit while it runs. `stopSync`
  kills the whole process group (`process.kill(-pid, "SIGTERM")`) and treats
  `ESRCH` (already dead) as success.

- **Tunnel flag order**: urfave/cli v2 stops parsing flags after positional
  args. Flags go before the sandbox ID: `tunnel --remote 5432 <id>`.

- **No git/GitHub integration**: Removed. The agent uses `bash` for git
  commands inside the sandbox. No auto-branch, no auto-push.

- **`sandbox_vpn_up` is advisory**: VPN needs sudo — the tool returns
  the command for the user to run in another terminal instead of executing it.

## Adding a new tool

1. Add the CLI wrapper function in `src/cli.ts`
2. Register the tool in `src/tools.ts` with:
   - `name: 'sandbox_<category>_<action>'`
   - `label: 'Title Case'`
   - `description:` what it does (1-2 sentences), plus any precondition
   - `promptSnippet:` one-liner
   - `promptGuidelines:` only if a bullet adds routing/ordering/warning signal the
     description and snippet do not already carry — otherwise omit the field
   - `parameters: Type.Object({...})`
   - `execute()` with try/catch returning `txt()` on error
3. If destructive, add `terminate: true` to the return value
4. If it needs `-o json`, verify the CLI command supports it (add `output.Render()` if not)
