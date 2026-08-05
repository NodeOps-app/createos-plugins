# @createos/pi

Pi coding agent extension that runs all tool calls inside a remote [CreateOS Sandbox](https://nodeops.network/createos) while the agent runs locally.

## Install

```bash
npm install -g @earendil-works/pi-coding-agent
pi install npm:@createos/pi
```

## Setup

Just have the CreateOS CLI installed and logged in:

```bash
createos login
```

That's it. No API keys, no env vars.

## Usage

```bash
pi --createos
```

Everything works inside the session — sandbox, networks, device access, port forwarding.

### Optional flags

| Flag               | Purpose                                          |
| ------------------ | ------------------------------------------------ |
| `--shape <shape>`  | Sandbox size (default: `s-2vcpu-2gb`)            |
| `--rootfs <name>`  | Base image or template                           |
| `--network <name>` | Network(s) to join at creation (comma-separated) |

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
pi --createos --network backend
```

## How it works

1. On `pi --createos`, checks that `createos` CLI is installed and logged in
2. Creates a sandbox via `createos sandbox create`
3. All Pi tools (bash, read, write, edit, ls, find, grep) run inside the sandbox via `createos sandbox exec` / `push` / `pull`
4. On exit, ephemeral sessions destroy the sandbox; persisted sessions keep it for resume

## Architecture

```
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
