# createos-sandbox (Codex plugin)

Codex plugin that offloads code to disposable [CreateOS](https://createos.sh) Sandboxes.
Gives Codex a skill + session hook that teach the agent how to use the `cos` driver
for one-shot offloads, reusable dev boxes, parallel fanout, tunnels, clusters, and more.

## Install

Copy or symlink the plugin into your project's `.codex/` directory:

```bash
# From this repo
cp -r packages/codex-plugin /path/to/your-project/.codex/plugins/createos-sandbox

# Or symlink for development
ln -s /path/to/createos-claude-plugins/packages/codex-plugin \
      /path/to/your-project/.codex/plugins/createos-sandbox
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

3. **Host tools:** `jq`, `tar`, `bash`, `base64`, `perl`, `curl`

## How it works

1. On session start, the hook publishes the `cos` driver's absolute path into context
2. The skill teaches Codex when and how to use sandbox commands
3. Codex runs `cos offload`, `cos up`, `cos run`, etc. via the bash tool
4. All commands execute inside remote CreateOS Sandboxes

## Commands

| Command | What |
|---|---|
| `cos offload <dir> <cmd>` | One-shot: stage dir → run → pull artifacts → destroy |
| `cos fanout <dir> <cmd1> [cmd2 …]` | Parallel: each command in its own box |
| `cos shell` | Instant throwaway Linux (user runs interactively) |
| `cos up` / `cos run` / `cos down` | Reusable project box |
| `cos sync <local> <remote>` | File sync (laptop → box) |
| `cos tunnel <port>` | Forward box port to localhost |
| `cos expose <port>` | Public HTTPS URL |
| `cos cluster up N` | N boxes on one private network |
| `cos disk create/attach/detach` | S3 disk mounts |
| `cos vpn register/up` | WireGuard VPN |
| `cos pause` / `cos resume` | Park/restore warm box |
| `cos fork` | Snapshot → independent clone |

## Architecture

```
packages/codex-plugin/
├── manifest.json                        # Plugin manifest
├── scripts/
│   ├── cos                              # CLI driver (same as claude-code-plugin)
│   └── session-start.sh                 # Session hook — publishes cos path
├── skills/
│   └── using-createos-sandbox/
│       ├── SKILL.md                     # Main skill
│       └── references/
│           ├── offload-and-egress.md
│           ├── networking.md
│           └── lifecycle-and-images.md
└── README.md
```

## Differences from Claude Code plugin

Minimal. The Codex plugin uses the same skill, references, and `cos` driver.
The only differences are:

- **Manifest format**: `manifest.json` (Codex) vs `.claude-plugin/plugin.json` (Claude Code)
- **Hook format**: Shell script output (Codex) vs JSON hook response (Claude Code)
- **No slash commands**: Codex uses skills + bash tool, not slash commands

## License

Apache-2.0
