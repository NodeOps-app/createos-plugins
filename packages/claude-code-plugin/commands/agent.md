---
description: Run another coding agent (Claude Code, Codex, OpenCode, Pi, Cursor) on your code inside a throwaway CreateOS sandbox — on OpenRouter, or any OpenAI- or Anthropic-compatible provider.
argument-hint: "[-P provider] [-m model] [-k KEYVAR] [-o .] [-p preset] [-s shape] <claude|codex|opencode|pi|cursor> <dir> <prompt>"
allowed-tools: Bash
---

Hand a coding task to a different agent, running in a disposable box. `devbox:1` ships `claude`, `codex`, `opencode`, `pi` and `cursor-agent`, so there is no install step. The agent runs headless with its permission gate off — the microVM is the isolation — and the box is destroyed afterwards.

`-P` picks the provider (`openrouter` default, or `anthropic`, `openai`, or a full `https://` base URL with `-k VAR`); `-m` the model as that provider spells it; `-k` names the host env var holding the key. Every `offload` flag also works: `-s` shape, `-x` excludes, `-v KEY` extra env, `-p`/`-e`/`-E` egress, `-K` keep on failure.

**Use `-o .` to pull the agent's edits back** — without it the work is destroyed along with the box. **The provider key must already be exported in the user's shell**; never ask them to paste one into the conversation.

Two agents have real limits: `cursor-agent` runs only on Cursor's own service (no third-party provider exists for it), and `codex` speaks only the OpenAI **Responses** wire, so a Chat-Completions gateway is rejected. `opencode` and `pi` work with anything.

!`test -n "$ARGUMENTS" && "${CLAUDE_PLUGIN_ROOT}/scripts/cos" agent $ARGUMENTS || "${CLAUDE_PLUGIN_ROOT}/scripts/cos" agent -h`

Report the agent's output and exit status above. If `-o .` was given, summarize what changed in the working tree (`git diff --stat`) rather than restating the agent's transcript. If it failed on auth, name which env var was missing; if it failed on a blocked host, add the matching `-p` preset.
