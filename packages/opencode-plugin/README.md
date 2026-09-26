# CreateOS Sandbox for OpenCode V2

Native OpenCode V2 plugin with explicit `sandbox_*` tools and optional remote execution of OpenCode's shell and file tools. Uses `Plugin.define`, tool transforms, session context hooks, commands, durable storage, and an importable RPC contract from `@opencode/plugin` **2.0.16**.

## Requirements

- OpenCode V2 with the 2.0.16 plugin API, running on macOS or Linux.
- The `createos` CLI installed on the **OpenCode server's** PATH. The managed-process and desktop commands used here are present in CLI v0.0.29.
- Authenticate on that server with `createos login`, or set `CREATEOS_API_KEY` in its environment.
- Guest image with Bash, Python 3.9+, tar, and ripgrep for file tools/search. Default: `devbox:1`.
- Host Git and tar for project snapshots; SSH keygen and the CLI's sync dependencies for watch mode.

The plugin uses CLI authentication for every operation, including desktop/computer use. Credentials stay on the server; do not put keys in plugin options or prompts. When changing server environment variables, restart the OpenCode service so it inherits them.

## Install from this checkout

```sh
cd packages/opencode-plugin
bun install
```

Add the package directory to `opencode.jsonc`. Relative paths resolve from the configuration file:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./packages/opencode-plugin"],
}
```

For a remote development session:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./packages/opencode-plugin",
      "options": {
        "mode": "remote",
        "sync": "once",
        "shape": "s-2vcpu-2gb",
        "rootfs": "devbox:1",
        "persist": true,
      },
    },
  ],
}
```

After publication, the package target is `@createos/opencode@2.0.0`:

```sh
opencode plugin add @createos/opencode@2.0.0
```

Use the same server-plugin configuration with an installation whose executable is named `opencode2`; substitute that executable in CLI commands.

## Execution modes

**Local (default):** native tools keep their existing executors. Explicit sandbox tools are available. Loading the plugin and listing its tools allocate no compute.

**Remote:** the first routed tool call lazily provisions one sandbox for that session. Concurrent first calls share the allocation; different sessions receive different sandboxes. The plugin preserves the native tools' input schemas and options while routing these tool IDs:

| Operation       | Tool IDs                |
| --------------- | ----------------------- |
| Shell           | `shell`, `bash`         |
| Read/write/edit | `read`, `write`, `edit` |
| Patch           | `patch`, `apply_patch`  |
| Search          | `glob`, `grep`          |

Remote failures fail the tool call. They never invoke the local executor. Relative paths resolve under the sandbox working directory; file-tool absolute paths under the host project map to that directory. Shell command strings are executed as supplied, from the remote working directory.

This routes registered agent tools. OpenCode's server, VCS, LSP, browser, MCP tools, interactive terminal infrastructure, and other plugins keep their own execution environments. A shell hook alone cannot relocate all of those services.

Use `sandbox_process_start` for persistent/background commands. Routed shell calls with `background: true` direct the agent to that tool.

Routed shell calls preserve `timeout: 0` as no deadline; session cancellation still terminates the remote process tree.

## Configuration

Environment overrides plugin options, which override defaults. Unknown option keys and invalid values fail plugin setup.

| Option       | Environment variable  | Default                                |
| ------------ | --------------------- | -------------------------------------- |
| `mode`       | `CREATEOS_MODE`       | `local`; alternatively `remote`        |
| `shape`      | `CREATEOS_SHAPE`      | `s-2vcpu-2gb`                          |
| `rootfs`     | `CREATEOS_ROOTFS`     | `devbox:1`                             |
| `cwd`        | `CREATEOS_CWD`        | `/root/workspace`                      |
| `network`    | `CREATEOS_NETWORK`    | unset                                  |
| `autoPause`  | `CREATEOS_AUTO_PAUSE` | `30m`                                  |
| `sync`       | `CREATEOS_SYNC`       | `none`; alternatively `once`           |
| `persist`    | `CREATEOS_PERSIST`    | `true`                                 |
| `timeout`    | `CREATEOS_TIMEOUT`    | `120000` milliseconds; maximum 3600000 |
| `syncSkills` | —                     | `true`                                 |

`CREATEOS_BIN` selects a different CLI executable. Plugin options never contain API credentials.

### Project and skill files

- `sync: "none"` creates an empty remote working directory.
- `sync: "once"` copies the project before the first operation. It does not overwrite it again on reattachment.
- Snapshots use Git's tracked/unignored file list in repositories and tar elsewhere. They exclude VCS metadata, `node_modules`, `.venv`, `.env*`, `.ssh`, `.aws`, `.createos`, `.opencode`, and private-key patterns. Treat exclusions as convenience filters, not secret discovery.
- Local skill bundles with a `SKILL.md` path are mirrored when the sandbox is attached. Original absolute paths remain usable by bundled scripts; project-relative file-tool mappings are also populated. Virtual/built-in skills without local bundles need no transfer.
- `sandbox_sync` supports `once`, `one-way`, and explicit `two-way` modes. Watchers return a transport ID and are stopped on plugin unload. `sandbox_transport_stop` stops them early.
- Remote-only changes stay remote unless an explicit pull, artifact download, or two-way sync retrieves them.

### Ownership and cleanup

With `persist: true`, session bindings live in OpenCode's plugin storage, scoped by location and session ID. Plugin reloads reattach to that sandbox, resuming it if paused. A disconnected UI, an idle session, or plugin unload does not destroy it. Auto-pause limits idle compute, but does not delete the sandbox.

`/sandbox` reports the current in-memory binding. `/sandbox-release` destroys the session's owned sandbox and clears its binding. `/sandbox-release forget` clears only the binding, useful after external deletion or when retaining the old sandbox deliberately. Release refuses while that session has active operations. The next remote operation creates a fresh sandbox.

With `persist: false`, plugin unload cancels in-flight operations and destroys the session sandboxes it owns. A hard process kill cannot run cleanup; inspect remaining sandboxes with the CLI after a server crash.

Sandboxes created explicitly with `sandbox_create`, forks, and `sandbox_process_start` are deliberate persistent resources. Destroy or stop them explicitly. One-shot jobs have their own cleanup policy below.

## Tool catalog

All tools are in the `sandbox` namespace and enabled for Code Mode. Effective names are `sandbox_<name>`.

| Group             | Names                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Session/lifecycle | `status`, `create`, `info`, `list`, `pause`, `resume`, `fork`, `destroy`                                                 |
| Execution         | `exec`, `run_code`, `offload`, `fanout`                                                                                  |
| Files             | `read`, `write`, `edit`, `patch`, `glob`, `grep`, `push`, `pull`                                                         |
| Processes         | `process_start`, `process_list`, `process_get`, `process_output`, `process_stop`, `process_input`, `process_close_stdin` |
| Transport/ingress | `sync`, `tunnel`, `transport_stop`, `ingress`, `preview_url`                                                             |
| Configuration     | `shapes`, `images`, `firewall`, `bandwidth`                                                                              |
| Networks          | `network_create`, `network_list`, `network_show`, `network_attach`, `network_detach`, `network_delete`                   |
| Disks             | `disk_create`, `disk_list`, `disk_show`, `disk_attach`, `disk_detach`, `disk_delete`                                     |
| Devices           | `device_register`, `device_status`, `vpn_up`                                                                             |
| Desktop           | `desktop`, `computer`, `screenshot`                                                                                      |

`network_attach`/`network_detach` accept either a sandbox or a registered device as `member`. `disk_create` takes **environment variable names** for S3 credentials. `vpn_up` returns the terminal command because connecting the host VPN requires interactive/elevated access.

### Execution and offload

- `exec` uses managed process start/wait/output. Cancellation or timeout explicitly stops the remote process tree. Output includes the process ID, remote exit code, separate stdout/stderr, and truncation state.
- CLI output is bounded to 2 MiB per invocation. The server's managed-process journal is also bounded; older output may have expired before retrieval.
- `run_code` supports `py`, `js`, `mjs`, `cjs`, `ts`, `sh`, `go`, `rb`, `c`, `cpp`, and `rs`. The selected guest image must contain the corresponding runtime/compiler.
- `offload` snapshots a project to `/work`. `out` optionally retrieves **one file** under `/work`, at the same relative path locally. Retrieval failure keeps the sandbox containing the artifact.
- Uncertain execution retains the sandbox for inspection; `keep_on_fail` optionally retains ordinary nonzero exits. Retention and cleanup failures name the sandbox explicitly.
- `fanout` accepts 1–25 commands and bounds concurrency (`jobs`, default 2). Each command gets its own project copy. It does not automatically publish services.
- Allocation is not retried or abandoned mid-response. If cancellation occurs while allocating, the returned ID is handled before cancellation completes.

### File behavior

Text reads/edits are limited to 1 MiB per file, with at most 2000 displayed read lines. Writes use atomic sibling-file replacement. File-tool calls serialize per sandbox; external shell processes can still modify the same files independently.

Edits require an exact unique match unless `replaceAll` is set. Patches support add, delete, update, and move sections with exact, unique line context. All hunks validate before mutation; individual writes are atomic, but a multi-file patch is not a filesystem transaction. Binary files use explicit transfers rather than text editing.

### Networking and desktop

Egress is unrestricted by default. `firewall` accepts IP/CIDR rules only: repository-recorded live checks found that hostname rules were accepted but not enforced. Address restrictions also have control-plane exceptions, including link-local services; this plugin does not claim complete network isolation.

Preview URLs and newly spawned tunnels are returned as **unverified**. Enable ingress explicitly and health-check the service before sharing it. Desktop access enables ingress and returns the CLI's noVNC connection information. Screenshots are returned as inline PNG file content so clients do not need access to server-local paths.

## RPC

Import the contract independently of the implementation:

```ts
import { CreateOS } from "@createos/opencode/rpc";

const sandbox = client.rpc(CreateOS);
await sandbox.status({ sessionID });
await sandbox.release({ sessionID, destroy: true });
```

Use an authenticated OpenCode client targeted at the plugin's location. RPC validates the session's location. `release({ destroy: false })` forgets the binding while leaving the sandbox allocated.

## Development

```sh
bun install
bun run check
bun test
bun pm pack
```

Tests exercise native-tool routing, initialization races, persistence, cancellation, artifact retention, cleanup failures, and real guest file operations. They use fake CreateOS transport responses and require no sandbox credentials. Live provisioning and a real OpenCode server require a separate integration smoke test, including a model-driven call to exercise OpenCode's result validation. Routed tools return remote results as content and sandbox metadata; their host-only structured output declarations are removed because they describe local resources and shell jobs.

Source modules: `plugin.ts` (V2 registration), `runtime.ts` (ownership), `cli.ts` (transport/processes), `tools.ts` (catalog/routing), `files.ts` + `guest.py` (file operations), `jobs.ts` (one-shot work), `sync.ts` (snapshots), `background.ts` (local transports), and `rpc.ts` (public contract).
