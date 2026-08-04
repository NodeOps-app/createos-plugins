<div align="center">

# CreateOS Integrations

**[Claude Code](https://docs.claude.com/en/docs/claude-code) plugin & [Pi](https://github.com/anthropics/pi) extension for disposable sandbox compute.**

Run code **off your machine** in disposable [CreateOS](https://createos.sh) Sandboxes — from Claude Code or Pi.

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-6E56CF)](https://docs.claude.com/en/docs/claude-code)
[![Pi](https://img.shields.io/badge/Pi-extension-F97316)](https://github.com/anthropics/pi)
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

```bash
# 1. Add the marketplace + install the plugin
/plugin marketplace add NodeOps-app/createos-claude-plugins
/plugin install claude-code-plugin@createos

# 2. Offload a heavy test run to a throwaway box (auto-destroys)
/createos-sandbox:offload . "npm ci && npm test"
```

The `createos` CLI **auto-installs** on first use. Sign in once with `createos login` (browser OAuth, run it in your own terminal) or `export CREATEOS_API_KEY=<key>`; check with `cos auth`. Prefer a local checkout? See [Install](#install).

## Packages

| Package | What it does |
|---|---|
| [**claude-code-plugin**](./packages/claude-code-plugin) | Hooks-based Claude Code plugin — offload, parallel fanout, scratch shell, reusable box with sync, port tunnel, public HTTPS expose, private-network clusters, BYO-S3 disk mounts, WireGuard VPN, and snapshot/fork — all driving the authed `createos` CLI. |
| [**pi-extension**](./packages/pi-extension) | Pi coding agent extension that transparently routes all built-in commands (bash, read, write, edit, ls, find, grep) to a remote CreateOS Sandbox, plus 26 additional tools for sandbox lifecycle, configuration, port tunnels, file sync, private networks, persistent disks, and device VPN — 33 tools total. |

## Commands at a glance

| Command | What |
|---|---|
| `/createos-sandbox:offload <dir> <cmd>` | one-shot: stage → run → pull artifacts → destroy |
| `/createos-sandbox:fanout <dir> <cmd1> [cmd2 …]` | run each command in its own throwaway box, in parallel |
| `/createos-sandbox:shell` | instant throwaway interactive Linux (destroyed on exit) |
| `/createos-sandbox:up` · `run` · `sync` · `down` | reusable per-repo box + file sync for live dev loops |
| `/createos-sandbox:tunnel <port>` | forward a box port to `127.0.0.1` (private) |
| `/createos-sandbox:expose <port>` | public HTTPS URL for a box port |
| `/createos-sandbox:cluster …` | N boxes on one private network, name-addressable |
| `/createos-sandbox:disk …` | mount your own S3 bucket into the project box |
| `/createos-sandbox:vpn …` | WireGuard L3 into your private networks |
| `/createos-sandbox:fork` | snapshot the project box → independent clone |
| `/createos-sandbox:pause` · `resume` | park the warm box at zero compute cost, then restore it exactly |
| `/createos-sandbox:template …` | build a custom image so boxes boot with the toolchain already installed |
| `/createos-sandbox:status` | show active box + sync + tunnels + cluster |

Full flags, networking guide, and heavy-build tips live in the [**Claude Code Plugin README**](./packages/claude-code-plugin/README.md).

## Pi extension

For [Pi](https://github.com/anthropics/pi) users, the `pi-extension` package provides 33 tools that transparently route all coding operations to a remote CreateOS Sandbox.

### Quick start

```bash
pi install npm:@createos/pi
pi --createos
```

### Flags

| Flag | Purpose |
|------|---------|
| `--createos` | Activate the extension |
| `--shape <shape>` | Sandbox size (default: `s-2vcpu-2gb`) |
| `--rootfs <name>` | Base image or template |
| `--network <name>` | Network(s) to join at creation |

### In-session commands

| Command | Description |
|---------|-------------|
| `/sandbox` | Show sandbox status |
| `/network <sub>` | Network CRUD (create, ls, show, rm, attach, detach) |
| `/device <sub>` | Device status, attach, detach |

## Install

**From GitHub (recommended):**
```
/plugin marketplace add NodeOps-app/createos-claude-plugins
/plugin install claude-code-plugin@createos
```

**From a local checkout:**
```
git clone https://github.com/NodeOps-app/createos-claude-plugins
/plugin marketplace add /path/to/createos-claude-plugins
/plugin install claude-code-plugin@createos
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
│  └─ pi-extension/                   # Pi extension (TypeScript)
│     ├─ index.ts                     # extension entry point
│     ├─ src/                         # tools, CLI wrappers, ops
│     └─ README.md
├─ apps/                              # (future starter templates)
├─ docs/
│  └─ adr/                            # architecture decision records
└─ README.md
```

## Contributing

Issues and PRs welcome. The plugin is a thin Claude Code surface over the [`createos`](https://createos.sh) CLI — most command logic lives in [`claude-code-plugin/scripts/cos`](./packages/claude-code-plugin/scripts/cos). Keep the slash-command, skill, and CLI surfaces aligned.

## Links

- 🌐 [createos.sh](https://createos.sh) — CreateOS platform
- 📖 [Claude Code plugins](https://docs.claude.com/en/docs/claude-code) — how plugins & marketplaces work
- 📦 [Claude Code Plugin README](./packages/claude-code-plugin/README.md) — full command & flag reference
- 🔧 [Pi Extension README](./packages/pi-extension/README.md) — Pi extension setup & tool inventory
