# createos-sandbox-codex

Run code in disposable [CreateOS](https://createos.sh) sandboxes. Track durable
jobs, inspect logs and exit codes, and download output files through MCP tools
and an optional job panel.

Jobs survive MCP client disconnects. Compatible MCP Apps hosts can show the
job panel in a sidebar or conversation; Codex CLI exposes the same job data
through tools.

## Install

```bash
# 1. Add the marketplace
codex plugin marketplace add NodeOps-app/createos-plugin

# 2. Install the plugin
codex plugin add createos-sandbox-codex --marketplace createos
```

Restart Codex after updating the installed plugin. Open `/hooks` in the CLI and
review and trust the plugin hooks. Installation does not automatically trust
them. Without trust, automatic setup and offload hints do not run.

The package uses root `plugin.json` and `mcp.json`. The `.codex-plugin` overlay,
`.mcp.json`, and `manifest.json` remain for compatibility with older hosts.

## Prerequisites

1. **createos CLI** — the session-start hook runs `cos setup`, which installs
   it if missing (`curl -sfL …/install.sh | sh -`) and otherwise upgrades it in
   place in the background. `COS_NO_AUTOINSTALL=1` disables this; a `COS_CLI`
   binary is never auto-installed.

2. **Sign-in** — if you are signed out and `tmux` is available, `cos setup`
   starts `createos login` in a hidden tmux session (`createos-login`) and your
   browser opens the CreateOS sign-in page; finish it there. Without `tmux`,
   run `createos login` in your own terminal. Or export `CREATEOS_API_KEY` to
   skip it. To sign in with an API token instead,
   `tmux kill-session -t createos-login`, then run `createos login` and pick
   "Sign in with API token". Never paste an API key into the agent chat.

3. `jq`, `tar`, `perl`, `curl` — `cos` needs them; the session-start hook is a
   no-op without `jq`.

4. **Node.js 22+ and tmux** — required for the MCP job tools. The shipped `mcp/`
   bundles include their dependencies; an installed plugin needs no `npm install`.
   Without these tools, the existing `cos` commands remain available; tmux is
   optional for those commands except automatic browser sign-in.

## Quickstart

After installing and signing in, launch Codex in your project directory. Try:

> Run this project's tests in a CreateOS sandbox. Install dependencies with
> internet access, save the test output as `test-results.txt`, and return the
> job ID and output file.

> Show my CreateOS jobs and the logs for the latest job.

> Explain CreateOS sandbox lifecycle and show a TypeScript SDK example using
> the current official documentation.

For tasks that need no internet, request denied network access. For an
interactive shell, reusable environment, or port tunnel, ask for the `cos`
workflow instead of a one-shot job.

## Sandbox knowledge and docs

The `createos-sandbox-docs` skill answers product and developer questions using
the [official documentation](https://createos.sh/docs/Sandbox). It reuses the
Claude Code plugin's synchronized docs index, covering CLI, REST API, SDKs,
limits, lifecycle, networking, storage, and integrations. Relevant pages are
fetched live; moved links are resolved through the official `llms.txt` index.
Startup context and MCP instructions route documentation questions to this
skill. No sandbox creation or sign-in is needed to read public docs.

For account awareness, `list_sandboxes` queries live sandbox IDs, names, and
states. `list_jobs` shows this workspace's local job history.

## Durable jobs

Ask the agent to run a task in a CreateOS sandbox, or invoke `start_job` with:

```json
{
  "directory": ".",
  "command": "python3 main.py > results.txt",
  "artifactPaths": ["results.txt"],
  "network": "denied"
}
```

The tool returns a job ID promptly. Each worker runs in a dedicated tmux server,
so closing the MCP client does not stop the worker. Use `get_job` for state,
`get_job_logs` for recent output, and `list_artifacts` or `download_artifact`
for output files. `open_jobs` opens the panel when the host supports it.

| Tool | Purpose |
| --- | --- |
| `start_job` | Upload a local directory and queue a remote command |
| `get_job` | State, exit code, sandbox ID, and cleanup warnings |
| `get_job_logs` | Up to 64 KiB of recent output |
| `list_jobs` | Recent jobs for the workspace |
| `open_jobs` | Job panel in compatible hosts; job data in other clients |
| `list_artifacts` | Retrieved file names, sizes, and resource URIs |
| `download_artifact` | Resource link for one retrieved file |
| `list_sandboxes` | Account sandbox IDs, names, and states |

Use the returned `job.id` as `jobId` in subsequent calls:

```json
{"jobId": "<job.id>"}
```

That argument works with `get_job`, `get_job_logs`, and `list_artifacts`.
For `download_artifact`, also supply `"name": "results.txt"`. Read the returned
MCP resource to obtain the file bytes, or use Download in the panel. Poll status
every five seconds until `succeeded` or `failed`; inspect `exitCode`, `kept`, and
`warnings` before reporting the result.

Directories must be inside the server's configured workspace. The default is
its inherited working directory; `open_jobs` reports that path. Set
`CREATEOS_WORKSPACE_ROOT` before launching the host to select a different root.
The server checks real paths, including directory symlinks. Common build
directories, `.git`, `.env` files, and common credential directories are excluded
from staging. Do not put other secrets in a directory you ask it to upload.

Outbound access is denied by default. Choose `network: "unrestricted"` explicitly
for a trusted task that needs the internet, such as downloading dependencies.
The MCP API does not offer hostname presets as enforced security controls.

Each job accepts up to 20 individual artifact files, each at most 8 MiB. Output
goes into private job storage and does not overwrite the checkout. Artifact
links are read through MCP resources, so binary bytes do not enter model context.
If execution becomes uncertain, a requested download fails, or cleanup fails,
the job reports `failed` and identifies any retained sandbox. Retained sandboxes
require review and manual cleanup. A worker killed during sandbox allocation
may not have recorded its ID; check the account list for `cos-j-` names.

Job state is scoped to the workspace and stored under `CREATEOS_JOB_DATA`, then
`PLUGIN_DATA`, then `~/.cache/createos-sandbox/jobs`, in that order. The server
lists the latest 100 jobs and admits up to eight active jobs per server instance.

This release supplies local stdio tools. Testing the panel in ChatGPT requires
a compatible local MCP connection or Secure MCP Tunnel. It does not deploy a
hosted endpoint, configure OAuth, or register an app connection.

## How it works

1. The session-start hook runs `cos setup`, prints the driver's absolute path and
   the CLI version/sign-in status into Codex's context, and states the verb rule (`offload` for work with a finish line, `up`/`run`
   for work that outlives one command).
2. A `pre-tool-use` hook watches shell calls and suggests offloading when it sees
   a heavy build or test. Advisory only — it never blocks. Silence with
   `COS_NO_HINT=1`.
3. The `using-createos-sandbox` skill carries the depth: egress restriction,
   networking, lifecycle, images.
4. Shell workflows use `cos`. MCP jobs use the shared execution engine through
   the same authenticated `createos` CLI, including staging and keepalive.

**Do not hand-roll offloads out of raw `createos sandbox create/push/exec`.**
That path looks equivalent and silently drops egress restriction, the keepalive
that survives a dropped stream on a long build, guaranteed auto-destroy, and the
auth preflight.

## Verbs

Run `cos help` for the full list.

| Verb                          | What                                                         |
| ----------------------------- | ------------------------------------------------------------ |
| `cos offload <dir> '<cmd>'`   | one-shot: stage → run (keepalive) → pull → destroy           |
| `cos fanout <dir> '<cmd>'...` | each command in its own throwaway box, in parallel           |
| `cos shell`                   | instant throwaway interactive Linux, destroyed on exit       |
| `cos up` / `run` / `down`     | reusable project box, one per git root                       |
| `cos sync`                    | background file sync into the project box                    |
| `cos pause` / `resume`        | park a warm box at zero compute cost, restore it intact      |
| `cos fork`                    | snapshot the project box into an independent clone           |
| `cos tunnel` / `expose`       | box port → `127.0.0.1`, or a public HTTPS URL                |
| `cos cluster`                 | N boxes on one private network, addressable by name          |
| `cos disk`                    | BYO S3 bucket mounts                                         |
| `cos vpn`                     | WireGuard into your private networks                         |
| `cos template`                | build a custom rootfs from a Dockerfile                      |
| `cos desktop` / `computer`    | graphical box + noVNC URL; drive it by screenshot/click/type |

## Architecture

The shell workflow shares the Claude Code plugin's `cos` driver and skill.
The MCP worker bundles `packages/shared/sandbox-engine.ts` at build time.
`scripts/cos`, `scripts/offload-hint.sh`, and `skills/using-createos-sandbox/`
are synchronized copies from `packages/claude-code-plugin/`; edit those
originals and run `scripts/sync-shared.sh` from the repository root.

```
packages/codex-plugin/
├── plugin.json                  # portable identity and OpenAI presentation
├── mcp.json                     # portable local MCP server configuration
├── .codex-plugin/plugin.json    # compatibility overlay
├── .mcp.json                    # compatibility MCP configuration
├── manifest.json                # older compatibility manifest
├── hooks/hooks.json             # SessionStart and PreToolUse hooks
├── mcp/                         # shipped server, worker, and panel bundles
├── src/                         # MCP server, worker, job storage, and panel source
├── tests/                       # protocol, worker, and package checks
├── skills/sandbox-jobs/          # durable MCP job workflow
├── skills/createos-sandbox-docs/ # product and developer docs routing
├── skills/using-createos-sandbox/
│   ├── SKILL.md                 # copy — canonical lives in claude-code-plugin
│   └── references/              # copies — offload-and-egress, networking, lifecycle-and-images
├── scripts/
│   ├── cos                      # copy — the driver
│   ├── offload-hint.sh          # copy — pre-tool-use nudge
│   ├── session-start.sh         # codex-specific: resolves cos relative to itself
│   ├── start-mcp.sh             # launches the bundled stdio server
│   └── build.mjs                # builds server, worker, and inline panel
└── README.md
```

`scripts/session-start.sh` resolves the driver relative to its own location.
Current Codex plugin hooks
receive `PLUGIN_ROOT` and compatibility variables, including
`CLAUDE_PLUGIN_ROOT`; ordinary agent shell calls must not assume those variables
exist. The wire format is identical — Codex parses
`hookSpecificOutput.additionalContext` exactly like Claude Code does.

Symlinking the shared files instead of copying them does not work: the Codex
plugin installer copies regular files only, so a symlinked repo installs with no
driver and no skill, silently. Verified against codex-cli 0.153.4.

## Differences from the Pi and OpenCode plugins

| Capability     | Pi                            | OpenCode                             | Codex                                                            |
| -------------- | ----------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| Integration    | `pi.registerTool()`           | `tool()` in plugin                   | local MCP server, skills, and hooks                              |
| Custom tools   | 34 registered tools           | 38 registered tools                  | 8 MCP tools plus shell workflows                                 |
| Slash commands | no                            | no                                   | no (Claude Code plugin has 20)                                   |
| Install        | `pi install npm:@createos/pi` | `opencode plugin @createos/opencode` | `codex plugin add createos-sandbox-codex --marketplace createos` |

## Development

From `packages/codex-plugin/`, with Node.js 22+ and tmux installed:

```bash
npm ci --ignore-scripts
npm run check
bash ../../scripts/sync-shared.sh --check
```

| Command | Purpose |
| --- | --- |
| `npm run build` | Rebuild `mcp/server.mjs`, `mcp/worker.mjs`, and `mcp/job-panel.html` |
| `npm run typecheck` | Check TypeScript sources |
| `npm test` | Run tests against sources and the current bundles |
| `npm run check` | Type-check, rebuild, and run all tests |

For a local MCP client, configure `command: "bash"` and
`args: ["/absolute/path/to/packages/codex-plugin/scripts/start-mcp.sh"]`.
Set its working directory to your project or pass `CREATEOS_WORKSPACE_ROOT`.
The launcher communicates through MCP stdio; run it through an MCP client.

| Environment variable | Use |
| --- | --- |
| `CREATEOS_WORKSPACE_ROOT` | Workspace containing directories that jobs may upload; defaults to server working directory |
| `CREATEOS_JOB_DATA` | Custom local job storage; otherwise uses `PLUGIN_DATA`, then `~/.cache/createos-sandbox/jobs` |
| `CREATEOS_API_KEY` | Optional API authentication inherited from the launching environment; CLI sign-in also works |

`check` type-checks the sources, rebuilds the shipped bundles, and runs the
tests. Commit the generated `mcp/` files with source changes so marketplace
installations remain self-contained. Packaging tests run the bundled server
without `node_modules` and execute hooks from a different working directory.
Worker lifecycle tests use a simulated engine. The detached-worker integration
test uses a fake CreateOS CLI and real tmux; it checks completion after the MCP
client disconnects. These tests do not allocate cloud sandboxes. The execution
environment must permit tmux to create its local socket. A live cloud run and
visual checks in a real MCP Apps host are still required before publishing a
release.

## License

Apache-2.0
