# @createos/pi

Pi coding agent extension that runs all tool calls inside a remote [CreateOS Sandbox](https://nodeops.network/createos) while the agent runs locally.

## Setup

```bash
curl -sfL https://raw.githubusercontent.com/NodeOps-app/createos-cli/main/install.sh | sh -
# Install from the repository root. The root manifest exposes this extension.
pi install git:github.com/NodeOps-app/createos-claude-plugins
createos login
```

The repository root forwards Pi's package entry point to this extension. No API keys, no env vars.

## Usage

```bash
pi --createos
```

Everything works inside the session — sandbox, networks, device access, port forwarding.

### Optional flags

| Flag                          | Purpose                                          |
| ----------------------------- | ------------------------------------------------ |
| `--createos-shape <shape>`    | Sandbox shape (default: `s-2vcpu-2gb`)           |
| `--createos-rootfs <name>`    | Base image or template                           |
| `--createos-network <name>`   | Network(s) to join at creation (comma-separated) |
| `--createos-sync-once`        | Copy the host project to `/root/workspace` first |
| `--createos-avoid-git-ignore` | Include files ignored by Git during that copy    |
| `--createos-watch`            | Keep the host project and sandbox in sync        |

`--createos-sync-once` and `--createos-watch` cannot be combined. The former copies
host files once, keeps sandbox-only files, and excludes VCS metadata plus Git-ignored
files by default. `--createos-avoid-git-ignore` includes Git-ignored files.
`--createos-watch` starts a two-way Mutagen sync for the session.

Before the first agent turn, loaded Pi skill directories are mirrored to their
original absolute paths in the sandbox. Only the loaded skill directories and
their bundled files are copied; Pi credentials, settings, and sessions stay local.

### In-session commands

| Command                    | Description                           |
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

### Agent tools

The LLM agent has these tools available automatically:

- **`sandbox_manage`** — full lifecycle: pause, resume, fork, destroy, ingress, firewall, bandwidth, shapes, images
- **`tunnel`** — port-forward a sandbox port to `localhost` on the user's machine
- **`preview_url`** — get a public HTTPS URL for any port in the sandbox
- **`network`** — create/manage private networks for sandbox-to-sandbox communication
- **`device`** — check device status, attach to networks for direct IP access

### Private networks

Sandboxes on the same network can reach each other by IP:

```bash
pi --createos --createos-network backend
```

## How it works

1. On `pi --createos`, checks that `createos` CLI is installed and logged in
2. Creates a sandbox via `createos sandbox create`
3. All Pi tools (bash, read, write, edit, ls, find, grep) run inside the sandbox via `createos sandbox exec` / `push` / `pull`
4. Mirrors loaded Pi skill directories into the sandbox before the first agent turn
5. Optional `--createos-sync-once` copies the host project to `/root/workspace`; `--createos-watch` starts a two-way sync
6. On exit, ephemeral sessions destroy the sandbox; persisted sessions keep it for resume

## Architecture

```text
Your machine                          CreateOS
┌──────────────────┐                  ┌─────────────────────┐
│  Pi agent (LLM)  │                  │  Sandbox             │
│                  │ ── createos ──▶  │  code execution      │
│  tool calls      │    CLI           │  file I/O            │
└──────────────────┘                  └─────────────────────┘
                                               │
                                               │ private network
                                               ▼
                                        Other sandboxes
                                        (same network)
```

Zero HTTP client code. Every operation is a `createos` CLI call.
