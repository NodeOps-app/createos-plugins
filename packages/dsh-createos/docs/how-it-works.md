# How dsh-createos works

`dsh-createos` replaces the DeepSeek Harness filesystem and subprocess providers with implementations backed by one CreateOS sandbox. The browser never calls CreateOS directly and never receives the sandbox API key.

See the README [Web quick start](../README.md#quick-start-web) for installation, launch, smoke-test, and shutdown commands.

## Composition

A DSH profile is an ordered Cordis plugin composition. Installing this package adds its [`cordis.patch.yml`](../cordis.patch.yml) as a bundle layer. That layer disables the local filesystem, subprocess, host-sandbox, and permission providers, then mounts:

- `createos`, which owns one shared sandbox;
- `fs-createos`, which provides `ctx.fs`;
- `subprocess-createos`, which provides `ctx.subprocess`;
- the existing Bash and terminal consumers over those providers.

Harness consumers depend on `ctx.fs` and `ctx.subprocess`, not concrete providers. Replacing those two services therefore moves Bash, file tools, LSP processes, and PTY terminals into the same remote execution environment without adding CreateOS-specific model tools.

## Web request flow

The browser communicates only with the DSH Web host:

```text
Browser
  -> Harness RPC and session events
  -> agent loop
  -> LLM
  -> structured tool call
  -> Harness tool consumer
  -> ctx.fs or ctx.subprocess
  -> dsh-createos provider
  -> CreateOS control plane
  -> sandbox guest agent
```

For example, a `hostname` request follows this path:

1. The browser submits the user message to the Web host.
2. The agent loop records the message and sends the assembled prompt and tool schemas to the selected LLM.
3. The LLM returns a structured `bash` tool call.
4. The Bash consumer constructs a subprocess request and calls `ctx.subprocess.spawn()`.
5. `CreateOSSubprocessRuntime` allocates the process through `POST /v1/sandboxes/:id/processes`, consumes its output stream, waits for completion, and returns stdout and stderr.
6. Harness records the tool result in the session log, runs the next model step when needed, and projects the events back to the browser.

The sandbox API key stays in the Host process environment throughout this flow.

## Sandbox lifecycle

`CreateOSRuntime` creates one sandbox when its Cordis entry activates. It initializes the configured working directory and a private `.dsh-createos` runtime directory, then shares the sandbox handle and managed-process client with the filesystem and subprocess providers.

The runtime destroys the sandbox when the plugin unloads or `lifetimeMs` expires. One mounted runtime currently means one sandbox shared by every DSH session served by that Web process.

## Filesystem operations

The standard Harness read, write, edit, glob, and search tools call `ctx.fs`. `CreateOSFileSystem` implements that interface using the CreateOS file API and bounded sandbox commands. It preserves Harness behavior such as canonical path resolution, UTF-8 validation, bounded reads, version checks, and atomic sibling-file replacement.

The filesystem and subprocess providers share the same `ctx.createos` owner, so a file written through a file tool is immediately visible to Bash and terminal processes.

## Processes and terminals

One-shot Bash execution calls `ctx.subprocess.spawn()`. Persistent terminal execution follows this path:

```text
terminal_open
  -> ctx.terminals.spawn()
  -> dsh-terminal-bash
  -> ctx.subprocess.spawnTerminal()
  -> CreateOS managed PTY
```

Managed operations map to these routes:

```text
create process or PTY  POST   /v1/sandboxes/:id/processes
list resources         GET    /v1/sandboxes/:id/processes
inspect resource       GET    /v1/sandboxes/:id/processes/:process_id
stream output          GET    /v1/sandboxes/:id/processes/:process_id/connect
send input             POST   /v1/sandboxes/:id/processes/:process_id/input
close stdin            POST   /v1/sandboxes/:id/processes/:process_id/stdin/close
resize PTY             POST   /v1/sandboxes/:id/processes/:process_id/resize
send signal            POST   /v1/sandboxes/:id/processes/:process_id/signal
wait for exit          GET    /v1/sandboxes/:id/processes/:process_id/wait
terminate process tree DELETE /v1/sandboxes/:id/processes/:process_id
```

Managed-process identifiers are treated as opaque values. Ambiguous mutating requests are not retried automatically.

## Workspace provisioning

The runtime currently creates only its configured `cwd`. A Web session can select a different absolute workspace path, but that path may not exist inside the sandbox. A subprocess started with a missing `cwd` then fails during process creation.

Deployments must currently create or synchronize the selected workspace inside the sandbox before executing tools. Automatic per-session workspace provisioning and host-to-sandbox synchronization remain integration work; the plugin must not imply that a host directory is already present remotely merely because both paths use the same spelling.

## Security model

The bundle disables the Host kernel sandbox and permission-preset provider because they cannot constrain a remote kernel. CreateOS is the execution isolation boundary. The Browser has no direct control-plane credentials, and all sandbox operations pass through the trusted DSH Host and the plugin's validated service interfaces.
