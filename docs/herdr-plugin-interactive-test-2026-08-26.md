# Interactive test — Herdr plugin `createos.sandbox`

Date: 2026-08-26
Tester: agent session, driven through real keystrokes, not scripted CLI calls.

## Why this test happened

Earlier testing drove the plugin actions and read status fields. Nobody ever sat
in the pane and typed. This test closes that gap.

## Setup

| Item | Value |
| --- | --- |
| Host | macOS, local `tmux` session `cosqa` |
| Herdr | 0.8.2, protocol 20, named session `cosqa` |
| CreateOS CLI | v0.0.25 |
| Plugin | linked from `packages/herdr-plugin` with `herdr plugin link` |
| Fixture | `/tmp/hh/fixture`, a Git repo with `app.py`, `README.md`, and a tracked `.env` |
| Input method | `tmux send-keys -t cosqa C-b S` and friends |
| Read-back | `herdr pane read <id>` and `herdr pane list` |

Herdr keybindings under test, written by `createos sandbox setup herdr`:

```
prefix+shift+s  start      prefix+shift+i  info
prefix+shift+c  attach     prefix+shift+x  delete
prefix+shift+y  sync       prefix+shift+a  apply
```

## Results per agent

Every agent was started with `prefix+shift+S` after setting `agent` in
`~/.config/herdr/plugins/config/createos.sandbox/config.json`.

| Agent | Sandbox | Install + attach | Live PTY | Stops at |
| --- | --- | --- | --- | --- |
| `claude-code` | `hd-fixture-wksm7c` | pass, 20 s | pass | login method picker |
| `codex` | `hd-fixture-39p685` | pass, 19 s | pass | ChatGPT sign-in picker |
| `opencode` | `hd-fixture-hx9h1w` | pass, 16 s | pass | `/connect` provider prompt |
| `pi` | `hd-fixture-pon5a8` | pass, 25 s | pass | `/login` provider prompt |
| `cursor` | `hd-fixture-z44cu0` | pass, 12 s | pass | "Press any key to log in" |

The login screen is the correct stopping point. No agent credentials were placed
in any sandbox.

Interactive input was proved on `claude-code`. Pressing Enter on the theme
picker advanced the screen to the login picker. Input travels from the keyboard,
through Herdr, through `createos sandbox process attach`, into the agent.

Herdr classified every pane correctly. `herdr pane list` reported the right
`agent` value and `agent_status: idle`, and each pane label carried its sandbox
name. The `HERDR_AGENT` detection contract works.

## Findings

### 1. The agent never lands in the uploaded repository — blocking

`launch()` in `src/main.ts` passes `--cwd /workspace` to
`createos sandbox process start`. The flag is documented and accepted. It is
silently ignored.

Measured in the sandbox:

```
opencode cwd=/root
codex    cwd=/root
```

Direct proof against the CLI, with no plugin involved:

```
createos sandbox process run <box> --cwd /workspace -- pwd   ->  6 bytes  "/root\n"
createos sandbox process run <box> --pty --cwd /workspace -- pwd -> 7 bytes "/root\r\n"
```

`/workspace` is 11 bytes. Both modes returned `/root`.

Effect: the plugin uploads the worktree to `/workspace`, then starts the agent in
`/root`. The agent cannot see the repository it was given.

Earlier testing missed this because `apply` and `sync` use `sandbox exec` with
explicit paths. The plumbing passed while the user-facing behavior was broken.

**Root cause, found on 2026-08-26.** The control plane is not at fault. The CLI
never sends the field. `urfave/cli` stops parsing flags at the first positional
argument, so every flag written after the sandbox name is discarded in silence.

```
createos sandbox process run <box> --cwd /workspace -- pwd
  body: {"cmd":"pwd"}                          cwd lost

createos sandbox process run --cwd /workspace <box> -- pwd
  body: {"cmd":"pwd","cwd":"/workspace"}       cwd sent
```

Captured with `CREATEOS_DEBUG=1`.

`createos-cli` already carried raw-argv fallbacks for this exact problem
(`processBoolFlag`, `processIntFlag`, `processInt64Flag`, `processStringFlag`,
`rawProcessFlagValue`). The `cwd`, `cmd`, and `env` reads never used them.

**Fixed on both sides.**

- `createos-cli`, branch `fix/process-string-flags`: wire `cwd` and `cmd` to the
  existing `processStringFlag`, and add `processStringSliceFlag` plus
  `rawProcessFlagValues` for the repeatable `--env`. Six tests added in
  `cmd/sandbox/process_flags_test.go`, one of which proves that values after
  `--` are never read as flags.
- `herdr-plugin`: every flag now goes before the sandbox name, in `launch()`,
  `sync()`, `boxExec()`, and both `sandbox rm --yes` calls. This alone fixes the
  plugin on the already-released CLI v0.0.25.

Verified end to end. The agent process now reports `cwd=/workspace`.

**The same bug is wider than `sandbox process`.** `cmd/sandbox/sync.go` reads
`--local`, `--remote`, and `--mode` with no raw fallback, so
`sandbox sync <box> --local ...` drops them and falls back to a prompt.
`sandbox exec <box> --stream` loses `--stream` the same way. The per-command
fallbacks are a workaround. The root fix is one argv reorder before parsing,
which would remove the need for all of them. That change touches every command,
so it needs a decision first.

### 2. Plugin action results never reach the screen — blocking on first install

Corrected on 2026-08-26 after a second round of testing. An earlier draft of
this report said the output was lost. That was wrong. Herdr records every
plugin action, with its exit code, stdout, and stderr. Read them with:

```
herdr plugin log list
```

The defect is narrower but still real. Nothing reaches the screen. A key press
produces no pane, no toast, and no status line, so the user cannot tell a
success from a failure without running a CLI command they have no reason to
know about.

Consequences:

- `info` shows the user nothing. The action has no use.
- `delete` asks the user to invoke it twice within 60 seconds. The user sees no
  prompt. The first press looks like a no-op.
- `apply` cannot tell the user whether it applied a patch or found no changes.
- Errors are silent. This is what made finding 2a below look like dead
  keybindings.

The plugin never calls `herdr notification show`, which exists and works.

### 2a. A GitHub install produces a broken `run.sh` — blocking

Root cause of the reported symptom "`prefix+shift+S` does nothing".

`build.sh` set `dir=$(cd "$(dirname "$0")" && pwd)` at build time and wrote that
absolute path into `run.sh`. During a GitHub install, Herdr runs `build.sh`
inside a temporary checkout, then moves the plugin to its final home and deletes
the temporary directory. The baked path then points at nothing.

Evidence from the live session, `herdr plugin log list`:

```
plugin-log-1  11:58:53  apply  exit=1  error: Module not found
  "/Users/ctos/.config/herdr/plugins/.tmp-install-26487-1787725580021/checkout/
   packages/herdr-plugin/src/main.ts"
plugin-log-2  11:58:54  info   exit=1  (same)
plugin-log-3  11:59:41  apply  exit=1  (same)
```

The keybindings fired correctly every time. Finding 2 hid the error.

Fixed in `build.sh`. `run.sh` now resolves its own directory at run time:

```sh
here=$(cd "$(dirname "$0")" && pwd)
exec "$BUN" "$here/src/main.ts" "$@"
```

Only the `bun` and `createos` paths stay baked, because they are absolute system
paths that the move does not affect.

Regression check: build the plugin in one directory, move the directory, then
run `run.sh` from the new location. Before the fix it printed `Module not
found`. After the fix it reaches `main.ts`.

### 3. `delete` leaves a dead pane behind

After two presses, the sandbox and its state entry were both gone. The pane
stayed open, still labelled `Claude Code @ hd-fixture-wksm7c`, showing a frozen
attach status bar. The pane had to be closed by hand with `herdr pane close`.

### 4. The PTY size is hardcoded

`launch()` passes `--rows 40 --cols 120`. The Herdr pane is almost never that
size, and the PTY is never resized when the pane resizes.

### 5. `dsh` is not a supported agent

`src/agents.ts` supports six keys: `claude-code`, `codex`, `opencode`, `pi`,
`cursor`, `shell`. This repository ships a `packages/dsh-createos` integration
for the DeepSeek Harness, but the Herdr plugin has no `dsh` entry.

### 6. Herdr's prefix key is `ctrl+b`

This is also the default `tmux` prefix. A user who runs Herdr inside `tmux` must
change one of them. Scripted `tmux send-keys` is unaffected.

### 7. `HOME` does not isolate a Herdr test run

`XDG_CONFIG_HOME` is set on this machine, so `HOME=/tmp/hh herdr` still read and
wrote `~/.config/herdr`. Use `herdr --session <name>` for isolation instead.

## What passed and is now proved

- The upload deny-list works live. A `.env` tracked by Git was in
  `git ls-files` and never reached the sandbox. `ENV_ABSENT` in `/workspace`.
- The sandbox baseline commit is created. `git log` in `/workspace` showed
  `herdr-baseline`.
- All five agent installers work inside a fresh sandbox.
- `start` creates the sandbox, uploads, installs, and opens an attached pane in
  12 to 25 seconds.
- `delete` needs two presses. One press does not destroy anything.
- Keybindings written by `createos sandbox setup herdr` all fire.

## Second round — the live Ghostty session, 12:25 to 12:32

The user reported that `prefix+shift+S` did nothing in their own Herdr session,
running in Ghostty. Findings 2 and 2a came out of that.

Two theories were tested and one was wrong.

- **Wrong theory.** The Herdr server socket was created at 11:58:49 and
  `config.toml` was written at 11:59:05, so the server looked as if it had
  started before the keybindings existed. `herdr server reload-config` was run.
  The plugin logs then showed key presses at 11:58:53, before the config write.
  The keybindings were loaded all along. The reload changed nothing.
- **Correct causes.** Finding 2a made every early press fail, and finding 2 hid
  the error. Later presses at 12:25 reached a working `run.sh` and failed for a
  second reason: the focused pane was `/Users/ctos`, which is not a Git
  repository, so `gitRoot()` threw.

End-to-end proof in the same live session, after both causes were understood:

```
herdr workspace create --cwd .../createos-plugin --label cos-keytest --focus
herdr plugin action invoke start --plugin createos.sandbox
-> plugin-log-7  start  status: succeeded  exit: 0
-> Claude Code 2.1.246 installed, sandbox hd-createos-plu-gd2g5r
-> pane wP:p2, agent claude, agent_status idle
```

Lesson for the plugin: an action that can fail must say so on screen. Silence
made a one-line path bug look like a dead keybinding.

## Cleanup

All five sandboxes were deleted. `createos sandbox list` reported zero
`hd-fixture` boxes. The `tmux` session and the Herdr `cosqa` session were
stopped. The plugin config was restored to its shipped default.
