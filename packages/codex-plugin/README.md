# @createos/codex

Codex plugin that offloads code to disposable [CreateOS](https://createos.sh) Sandboxes.
Gives Codex a skill that teaches the agent how to use the `createos` CLI
for sandbox lifecycle, networking, persistent disks, VPN, and more.

## Install

```bash
# 1. Add the marketplace
codex plugin marketplace add NodeOps-app/createos-claude-plugins

# 2. Install the plugin
codex plugin add @createos/codex@createos
```

## Prerequisites

1. **createos CLI** — auto-installs on first use, or manually:
   ```bash
   curl -sfL https://raw.githubusercontent.com/NodeOps-app/createos-cli/main/install.sh | sh
   ```

2. **Login** (one-time):
   ```bash
   createos login
   ```

## How it works

1. Plugin installs a skill that teaches Codex the `createos` CLI commands
2. When you ask to run code in a sandbox, Codex uses `createos sandbox create` + `createos sandbox exec`
3. All commands execute inside remote CreateOS Sandboxes, not on your machine

## Commands the skill teaches

| Command | What |
|---|---|
| `createos sandbox create` | Create a sandbox |
| `createos sandbox exec <id> -- sh -c '<cmd>'` | Run command inside sandbox |
| `createos sandbox list` | List sandboxes |
| `createos sandbox get <id>` | Sandbox status/IP/ingress |
| `createos sandbox rm <id> --yes` | Destroy sandbox |
| `createos sandbox pause/resume <id>` | Park/restore |
| `createos sandbox pull <id> <path> -` | Read file from sandbox |
| `createos sandbox tunnel --remote <port> --local <port> <id>` | Port forward |
| `createos sandbox network create/attach/show` | Private networks |
| `createos sandbox disk create/attach` | S3 disk mounts |
| `createos sandbox devices register` | Device VPN setup |

## Architecture

```
packages/codex-plugin/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest (name, skills ref)
├── skills/
│   └── using-createos-sandbox/
│       ├── SKILL.md             # Main skill — createos CLI commands
│       └── references/
│           ├── offload-and-egress.md
│           ├── networking.md
│           └── lifecycle-and-images.md
├── scripts/
│   ├── cos                      # CLI driver (advanced offload patterns)
│   └── session-start.sh         # Session hook
├── manifest.json
└── README.md
```

## Differences from Pi and OpenCode plugins

| Capability | Pi | OpenCode | Codex |
|---|---|---|---|
| Tool replacement | Yes — transparent | No — prompt injection | No — skill-based |
| Custom tools | 47 registered tools | 33 registered tools | None — uses bash + createos CLI |
| Integration | `pi.registerTool()` | `tool()` in plugin | Skill teaches CLI commands |
| Install | `pi install npm:@createos/pi` | `opencode plugin @createos/opencode` | `codex plugin add @createos/codex@createos` |

## License

Apache-2.0
