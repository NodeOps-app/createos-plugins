<div align="center">

# CreateOS Integrations

**[Claude Code](https://docs.claude.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [Pi](https://github.com/anthropics/pi) & [OpenCode](https://opencode.ai) plugins for disposable sandbox compute.**

Run code **off your machine** in disposable [CreateOS](https://createos.sh) Sandboxes — from Claude Code, Codex, Pi, or OpenCode.

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-6E56CF)](https://docs.claude.com/en/docs/claude-code)
[![Pi](https://img.shields.io/badge/Pi-extension-F97316)](https://github.com/anthropics/pi)
[![Codex](https://img.shields.io/badge/Codex-plugin-10A37F)](https://github.com/openai/codex)
[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-0EA5E9)](https://opencode.ai)
[![CreateOS](https://img.shields.io/badge/CreateOS-Sandboxes-0EA5E9)](https://createos.sh)
[![Spawn](https://img.shields.io/badge/create%20to%20first%20command-~200ms-22C55E)](https://createos.sh)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](#contributing)

</div>

---

## Why

Heavy builds, flaky test suites, and untrusted code don't belong on your laptop. `claude-code-plugin` gives Claude a skill + slash commands that offload them to throwaway CreateOS Sandboxes — created and running your first command in roughly 200 ms, self-destructing when done — so your machine stays free, your deps stay isolated, and untrusted code never touches local state.

- 🧨 **Disposable** — one-shot offload stages a dir, runs, pulls artifacts, then auto-destroys. Box-side changes never touch local unless you ask.
- ⚡ **Fast** — ~200 ms from create to first command; parallel fanout across N boxes for matrix builds and split test suites.
- 🔒 **Isolated** — untrusted code runs in a disposable Sandbox, not your shell. Egress can be locked to an exact allowlist.
- 🔁 **Live loops** — a reusable per-repo box with file sync, port tunnels, and public HTTPS expose for real dev sessions.
- 💤 **Cheap to keep** — `pause` snapshots a warm box (deps and all) at zero compute cost; `resume` brings it back in a handful of seconds.

## Quick start

**Claude Code:**

```bash
# 1. Add the marketplace + install the plugin
/plugin marketplace add NodeOps-app/createos-claude-plugins
/plugin install @createos/claude-code@createos

# 2. Offload a heavy test run to a throwaway box (auto-destroys)
/createos-sandbox:offload . "npm ci && npm test"
```

**Pi:**

```bash
# 1. Install the extension from this repository
pi install git:github.com/NodeOps-app/createos-claude-plugins

# 2. Start Pi locally with CreateOS sandbox tools available
pi

# Optional: create a sandbox and route Pi's built-in tools into it
pi --inside-createos-sandbox

# Optional: copy this project to /root/workspace before sandbox-mode Pi starts
pi --inside-createos-sandbox --createos-sync-once

# Optional: continuously sync this project and /root/workspace in sandbox mode
pi --inside-createos-sandbox --createos-watch
```

**Codex:**

```bash
# 1. Add the marketplace
codex plugin marketplace add NodeOps-app/createos-claude-plugins

# 2. Install the plugin
codex plugin add @createos/codex@createos

# 3. Launch codex — the skill teaches createos CLI usage
codex
```

**OpenCode:**

```bash
# 1. Install the plugin
opencode plugin @createos/opencode --global

# 2. Launch opencode — sandbox tools are available automatically
opencode
```

The `createos` CLI **auto-installs** on first use. Sign in once with `createos login` (browser OAuth, run it in your own terminal) or `export CREATEOS_API_KEY=<key>`; check with `cos auth`. Prefer a local checkout? See [Install](#install).

## Packages

| Package                                                 | What it does                                                                                                                                                                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [**claude-code-plugin**](./packages/claude-code-plugin) | Hooks-based Claude Code plugin — offload, parallel fanout, scratch shell, reusable box with sync, port tunnel, public HTTPS expose, private-network clusters, BYO-S3 disk mounts, WireGuard VPN, and snapshot/fork — all driving the authed `createos` CLI. |
| [**pi-extension**](./packages/pi-extension)             | Pi coding agent extension with all 33 `sandbox_*` tools for lifecycle, configuration, port tunnels, file sync, private networks, persistent disks, and device VPN. Built-in tools route remotely only with `--inside-createos-sandbox`.                    |
| [**@createos/codex**](./packages/codex-plugin)          | Codex plugin — skill that teaches the `createos` CLI for sandbox lifecycle, networking, disks, and VPN.                                                                                                                                                     |
| [**@createos/opencode**](./packages/opencode-plugin)    | OpenCode plugin with 33 sandbox tools (`sandbox_exec`, `sandbox_push`, `sandbox_pull`, networks, disks, VPN, sync) and system prompt injection for sandbox-first workflows.                                                                                 |

## Claude Code — commands at a glance

| Command                                          | What                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| `/createos-sandbox:offload <dir> <cmd>`          | one-shot: stage → run → pull artifacts → destroy                        |
| `/createos-sandbox:fanout <dir> <cmd1> [cmd2 …]` | run each command in its own throwaway box, in parallel                  |
| `/createos-sandbox:shell`                        | instant throwaway interactive Linux (destroyed on exit)                 |
| `/createos-sandbox:up` · `run` · `sync` · `down` | reusable per-repo box + file sync for live dev loops                    |
| `/createos-sandbox:tunnel <port>`                | forward a box port to `127.0.0.1` (private)                             |
| `/createos-sandbox:expose <port>`                | public HTTPS URL for a box port                                         |
| `/createos-sandbox:cluster …`                    | N boxes on one private network, name-addressable                        |
| `/createos-sandbox:disk …`                       | mount your own S3 bucket into the project box                           |
| `/createos-sandbox:vpn …`                        | WireGuard L3 into your private networks                                 |
| `/createos-sandbox:fork`                         | snapshot the project box → independent clone                            |
| `/createos-sandbox:pause` · `resume`             | park the warm box at zero compute cost, then restore it exactly         |
| `/createos-sandbox:template …`                   | build a custom image so boxes boot with the toolchain already installed |
| `/createos-sandbox:status`                       | show active box + sync + tunnels + cluster                              |

Full flags, networking guide, and heavy-build tips live in the [**Claude Code Plugin README**](./packages/claude-code-plugin/README.md).

## Pi — commands at a glance

Pi and built-in tools run locally by default. `--inside-createos-sandbox` routes built-ins (bash, read, write, edit, ls, find, grep) to a sandbox; all 33 sandbox lifecycle, networking, disk, and device-VPN tools remain available in either mode.

| Command                    | What                                  |
| -------------------------- | ------------------------------------- |
| `/sandbox`                 | Show sandbox status                   |
| `/network create <name>`   | Create a private network              |
| `/network ls`              | List your networks                    |
| `/network show <name>`     | Show network members + IPs            |
| `/network attach <name>`   | Join this sandbox to a network        |
| `/network detach <name>`   | Leave a network                       |
| `/network rm <name>`       | Delete a network                      |
| `/device status`           | Show registered devices               |
| `/device attach <network>` | Give your machine access to a network |
| `/device detach <network>` | Remove access                         |

### Flags

| Flag                          | Purpose                                |
| ----------------------------- | -------------------------------------- |
| `--inside-createos-sandbox`   | Run Pi inside a sandbox                |
| `--createos-shape <shape>`    | Sandbox shape (default: `s-2vcpu-2gb`) |
| `--createos-rootfs <name>`    | Base image or template                 |
| `--createos-network <name>`   | Network(s) to join at creation         |
| `--createos-sync-once`        | Copy project to `/root/workspace` once |
| `--createos-avoid-git-ignore` | Include Git-ignored files in that copy |
| `--createos-watch`            | Two-way project sync for this session  |

Use `--createos-sync-once`, `--createos-watch`, and other `--createos-*` flags with
`--inside-createos-sandbox`. The sync flags are mutually exclusive. The first preserves
sandbox-only files and excludes VCS metadata plus Git-ignored files by default;
`--createos-avoid-git-ignore` includes ignored files. The latter starts the existing two-way
sync. In sandbox mode, loaded Pi skill directories are mirrored before the first agent turn;
Pi credentials, settings, and sessions stay local.

Full tool inventory lives in the [**Pi Extension README**](./packages/pi-extension/README.md).

## OpenCode — tools at a glance (40)

| Category            | Tools                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Execute & Files** | `sandbox_exec`, `sandbox_pull`, `sandbox_push`                                                                         |
| **Lifecycle**       | `sandbox_create`, `sandbox_list`, `sandbox_info`, `sandbox_pause`, `sandbox_resume`, `sandbox_fork`, `sandbox_destroy` |
| **Config**          | `sandbox_ingress`, `sandbox_firewall`, `sandbox_bandwidth`, `sandbox_shapes`, `sandbox_images`                         |
| **Ports & Sync**    | `sandbox_preview_url`, `sandbox_tunnel`, `sandbox_sync`                                                                |
| **Networks**        | `sandbox_network_create/list/show/attach/detach/delete`                                                                |
| **Disks**           | `sandbox_disk_create/list/show/delete/attach/detach`                                                                   |
| **Device VPN**      | `sandbox_device_register/status/attach/detach`, `sandbox_vpn_up`                                                       |

Full reference in [opencode-plugin/README.md](./packages/opencode-plugin/README.md).

## Install

**From GitHub (recommended):**

```
/plugin marketplace add NodeOps-app/createos-claude-plugins
/plugin install @createos/claude-code@createos
```

**From a local checkout:**

```
git clone https://github.com/NodeOps-app/createos-claude-plugins
/plugin marketplace add /path/to/createos-claude-plugins
/plugin install @createos/claude-code@createos
```

**Dev (instant, no install):**

```bash
claude --plugin-dir /path/to/createos-claude-plugins/packages/claude-code-plugin
/reload-plugins      # after editing plugin files
```

## Requirements

- **[CreateOS](https://createos.sh) account** — the `createos` CLI auto-installs on first use. Opt out with `COS_NO_AUTOINSTALL=1`.
- **Sign-in** — `createos login` in your own terminal (interactive browser OAuth; Claude can't drive a TTY prompt), or `export CREATEOS_API_KEY=<key>` to skip the browser entirely. `cos auth` reports which is active.
- **Host tools:** `jq`, `tar`, `bash`, `base64`; `perl` for ANSI/path handling; `curl` for the one-time CLI install.

## Safety

- **One-way by default** — offload uploads and sync are laptop → box; box-side writes never flow back unless you opt in (`-2`).
- **Excludes** — `.git`, `node_modules`, `target`, `.venv`, and other regenerable dirs are stripped from uploads by default.
- **Scoped** — `cos` only ever touches boxes it created (`cos-*`) or the project box in its statefile. Your other sandboxes are never touched.
- **Quota** — external keys have been observed to allow 2 boxes running at once, with a daily creation cap. This is observed behaviour, not published policy — budget `cluster` and `fanout` against it and expect excess jobs to queue rather than fail.

## Repository layout

```
createos-claude-plugins/              # marketplace root
├─ .claude-plugin/
│  └─ marketplace.json                # marketplace manifest
├─ packages/
│  ├─ claude-code-plugin/             # hooks-based Claude plugin
│  │  ├─ .claude-plugin/plugin.json
│  │  ├─ commands/                    # slash commands
│  │  ├─ skills/                      # the using-createos-sandbox skill + references/
│  │  ├─ hooks/                       # SessionStart driver-path + PreToolUse offload-hint
│  │  ├─ scripts/cos                  # the CLI driver
│  │  └─ README.md
│  ├─ pi-extension/                   # Pi extension (TypeScript)
│  │  ├─ index.ts                     # extension entry point
│  │  ├─ src/                         # tools, CLI wrappers, ops
│  │  └─ README.md
│  ├─ codex-plugin/                  # Codex plugin
│  │  ├─ manifest.json
│  │  ├─ scripts/cos, session-start.sh
│  │  ├─ skills/using-createos-sandbox/
│  │  └─ README.md
│  └─ opencode-plugin/               # OpenCode plugin
│     ├─ index.ts                     # plugin entry (CreateOSPlugin)
│     ├─ src/cli.ts                   # createos CLI wrappers
│     ├─ src/tools.ts                 # 33 tool definitions
│     ├─ src/util.ts                  # shellQuote, shortId, joinPath
│     └─ README.md
├─ apps/                              # (future starter templates)
├─ docs/
│  └─ adr/                            # architecture decision records
└─ README.md
```

## Contributing

Issues and PRs welcome. All three plugins are thin surfaces over the [`createos`](https://createos.sh) CLI — keep the command surfaces aligned.

## Links

- [createos.sh](https://createos.sh) — CreateOS platform
- [Claude Code plugins](https://docs.claude.com/en/docs/claude-code) — how plugins & marketplaces work
- [OpenCode plugins](https://opencode.ai/docs/plugins/) — OpenCode plugin docs
- [Claude Code plugin README](./packages/claude-code-plugin/README.md)
- [Pi extension README](./packages/pi-extension/README.md)
- [Codex plugin README](./packages/codex-plugin/README.md)
- [OpenCode plugin README](./packages/opencode-plugin/README.md)
