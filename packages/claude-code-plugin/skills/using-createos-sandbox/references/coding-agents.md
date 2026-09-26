# Running coding agents in a box, on any model provider

Read this when the job is "let another coding agent do this work somewhere that isn't my laptop" — a second opinion on a diff, a long refactor you don't want holding your session, an untrusted repo you'd rather an agent touched inside a microVM, or the same task run by several agents to compare.

`devbox:1` (the default rootfs) ships five agent CLIs, so none of this needs an install step.

## Contents

- [What's in the image](#whats-in-the-image)
- [`cos agent` — the short version](#cos-agent--the-short-version)
- [Getting the key in](#getting-the-key-in)
- [Per-agent wiring, by hand](#per-agent-wiring-by-hand)
- [Which agent can use which provider](#which-agent-can-use-which-provider)
- [Restricting egress around an agent](#restricting-egress-around-an-agent)
- [Traps](#traps)

## What's in the image

Verified on a live `devbox:1` box (Ubuntu 24.04, runtimes under `asdf`):

| CLI            | Version seen | Headless invocation                                                                      |
| -------------- | ------------ | ---------------------------------------------------------------------------------------- |
| `claude`       | 2.1.260      | `claude -p --dangerously-skip-permissions '<prompt>'`                                    |
| `codex`        | 0.153.4      | `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox '<prompt>'` |
| `opencode`     | 1.18.30      | `opencode run --auto '<prompt>'`                                                         |
| `pi`           | 0.85.1       | `pi -p '<prompt>'`                                                                       |
| `cursor-agent` | 2026.09.10   | `cursor-agent -p --force '<prompt>'`                                                     |

Versions move; check with `cos offload . 'claude --version'` rather than quoting these. `desktop:1` ships the same five, which is what makes "run an agent on a box and let the user watch it work over noVNC" a thing you can do.

Every one of these runs with its permission gate off. That is the right setting _here_ and nowhere else: the microVM is the isolation, which is exactly the case `--dangerously-bypass-approvals-and-sandbox` and friends are documented for. Never carry these flags back to the user's machine.

## `cos agent` — the short version

```bash
export OPENROUTER_API_KEY=sk-or-...
cos agent -m openai/gpt-5.6-luna -o . claude . 'fix the failing tests'
```

That stages the directory, boots a box, wires `claude` to OpenRouter, runs it headless, tars the edits back into your tree, and destroys the box.

```
cos agent [flags] <agent> <local-dir> <prompt>
  agent     claude | codex | opencode | pi | cursor
  -P        openrouter (default) | anthropic | openai | https://<base-url>
  -m        model id, spelled the way that provider spells it
  -k VAR    host env var holding the key (default: OPENROUTER_API_KEY / ANTHROPIC_API_KEY /
            OPENAI_API_KEY / CURSOR_API_KEY)
  -o .      pull the agent's edits back into the local dir
  + every offload flag: -s -r -x -v -e -p -E -K
```

`-o` is not optional in spirit. Without it the box is destroyed with the agent's work inside it, and all you keep is the transcript. `-o .` extracts `/work` over your local directory — so run it on a clean git tree, where `git diff` tells you exactly what the agent did.

Comparing agents on one task is `fanout`'s shape, not `agent`'s — `cos agent` is one agent per call.

## Getting the key in

Use `-v`/`-k`, never string interpolation:

```bash
cos offload -v OPENROUTER_API_KEY . '<cmd>'     # forwards the value out of your shell
```

A bare `-v KEY` reads the value from the shell that launched the agent. `-v KEY=literal` also works but puts the secret in the command string, where it lands in the transcript and in shell history — only use it for things that aren't secret (`-v STAGE=dev`).

**Never ask the user to paste a provider key into the conversation.** Same rule as the CreateOS key itself: they export it in their own shell, and `-v` carries it from there. If it isn't exported, `cos` fails before creating the box and says which variable is missing.

## Per-agent wiring, by hand

`cos agent` exists because these five disagree on everything. When you need to do it manually — inside a `cos run` on a project box, in a template, as part of a longer script — this is the mapping, each verified against the binary in `devbox:1`.

### claude — Anthropic Messages wire only

```bash
export ANTHROPIC_BASE_URL=https://openrouter.ai/api      # note: NO /v1
export ANTHROPIC_AUTH_TOKEN=$OPENROUTER_API_KEY          # Bearer; ANTHROPIC_API_KEY sends x-api-key
export ANTHROPIC_MODEL='openai/gpt-5.6-luna[1m]'
export ANTHROPIC_DEFAULT_OPUS_MODEL='openai/gpt-5.6-luna[1m]'
export ANTHROPIC_DEFAULT_SONNET_MODEL='openai/gpt-5.6-luna[1m]'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='openai/gpt-5.6-luna'
export CLAUDE_CODE_SUBAGENT_MODEL='openai/gpt-5.6-luna'
export IS_SANDBOX=1
claude -p --dangerously-skip-permissions 'fix the failing tests'
```

Four things here are load-bearing:

- **`ANTHROPIC_AUTH_TOKEN`, not `ANTHROPIC_API_KEY`**, for OpenRouter. The first sends `Authorization: Bearer`, the second sends `x-api-key`. Against `api.anthropic.com` itself, use `ANTHROPIC_API_KEY` and set no base URL.
- **`https://openrouter.ai/api` with no `/v1`.** OpenRouter serves an Anthropic-compatible API at `/api` and an OpenAI-shaped one at `/api/v1`. Claude appends `/v1/messages` itself. The trailing `/v1` is the whole difference and they are not interchangeable — this is the single most common way to get an opaque 404.
- **Pin every alias, not just `ANTHROPIC_MODEL`.** An alias you leave unset resolves to a real Anthropic model id that the third-party provider has never heard of, and the run dies partway through on the first subagent or haiku-class call rather than at startup.
- **`IS_SANDBOX=1`.** The box runs as root, and claude refuses `--dangerously-skip-permissions` under root unless something else is doing the isolating. `--permission-mode bypassPermissions` hits the same guard — `IS_SANDBOX` is the only way through.

The `[1m]` suffix is not decoration. An unrecognized model id makes Claude Code assume a 200k context window and auto-compact against it; `[1m]` declares a 1M window, and `CLAUDE_CODE_MAX_CONTEXT_TOKENS` sets an exact one.

claude speaks one wire protocol. A plain OpenAI-compatible gateway will not work behind it — it needs an endpoint that serves `/v1/messages`.

### codex — OpenAI Responses wire only

`OPENAI_BASE_URL` is **not read** by codex, and `OPENAI_API_KEY` is not an auth source on its own. Configuration is `~/.codex/config.toml` or the file-free `-c` equivalent:

```bash
export OPENROUTER_API_KEY=sk-or-...
codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  -c model_provider='"openrouter"' \
  -c model_providers.openrouter.name='"OpenRouter"' \
  -c model_providers.openrouter.base_url='"https://openrouter.ai/api/v1"' \
  -c model_providers.openrouter.env_key='"OPENROUTER_API_KEY"' \
  -c model_providers.openrouter.wire_api='"responses"' \
  -m 'openai/gpt-5.6-luna' \
  'fix the failing tests'
```

`-c` values are parsed as TOML, so strings need their own inner quotes — `-c model_provider=openrouter` is a parse error, `-c model_provider='"openrouter"'` is correct.

**`wire_api = "chat"` is rejected outright** (verified on 0.153.4 — it fails at config load with "no longer supported"). Codex speaks only the Responses API, so a plain Chat-Completions gateway — vLLM, LiteLLM in chat mode, most things advertised as "OpenAI-compatible" — cannot drive it. There is no Anthropic wire in codex at all.

`--skip-git-repo-check` is required whenever `/work` isn't a git repo, and it is a hard error, not a warning. Codex retries a failed request 5 times before giving up, so a _blackholed_ (rather than refused) egress rule multiplies wall-clock time rather than failing fast.

### opencode — resolves the provider from its own catalog

The simplest of the five. The bare env var is enough — no config file, no login:

```bash
export OPENROUTER_API_KEY=sk-or-...
opencode run --auto -m openrouter/openai/gpt-5.6-luna 'fix the failing tests'
```

`-m` is provider-qualified, so the provider appears twice for OpenRouter: `openrouter/` (opencode's provider) then `openai/gpt-5.6-luna` (OpenRouter's model id). Key names come from the catalog: `openrouter` → `OPENROUTER_API_KEY`, `anthropic` → `ANTHROPIC_API_KEY`, `openai` → `OPENAI_API_KEY`.

For an endpoint that isn't in the catalog there is **no `--config` flag**; pass the config as inline JSON instead:

```bash
export OPENCODE_CONFIG_CONTENT='{
  "model": "mygw/my-model",
  "provider": { "mygw": {
    "npm": "@ai-sdk/openai-compatible",
    "options": { "baseURL": "https://gw.example.com/v1", "apiKey": "{env:MY_API_KEY}" },
    "models": { "my-model": {} } } } }'
opencode run --auto 'fix the failing tests'
```

Swap `@ai-sdk/openai-compatible` for `@ai-sdk/anthropic` to point at an Anthropic-compatible endpoint. `OPENCODE_DISABLE_AUTOUPDATE=1` and `OPENCODE_DISABLE_LSP_DOWNLOAD=1` drop its two GitHub calls; `OPENCODE_DISABLE_MODELS_FETCH=1` drops the catalog fetch, but only works if you declared the provider yourself as above.

### pi — a built-in provider, or one you declare

```bash
export OPENROUTER_API_KEY=sk-or-...
export PI_OFFLINE=1        # no update check, no telemetry — provider call only
pi -p --provider openrouter --model 'openai/gpt-5.6-luna' 'fix the failing tests'
```

OpenRouter, Anthropic and OpenAI are built in, keyed off the usual env vars. A custom base URL needs a provider in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "mygw": {
      "baseUrl": "https://gw.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$MY_API_KEY",
      "models": [{ "id": "my-model", "contextWindow": 256000, "maxTokens": 8192 }]
    }
  }
}
```

`api` also accepts `anthropic-messages`, `openai-responses`, and several cloud-specific wires — pi is the most protocol-flexible of the five. `cos agent` doesn't write that file for you; do it in the command, or bake it into a template.

pi ships no permission prompts and no sandbox of its own — its tools run with full privileges by design. That is fine inside a microVM and is the entire reason to put it in one.

### cursor-agent — Cursor's own service, and only that

There is no third-party provider path. `cursor-agent` has `-e/--endpoint` and `CURSOR_API_ENDPOINT` (default `https://api2.cursor.sh`), but that expects Cursor's own API protocol — it is for routing through an enterprise proxy, not for reaching OpenRouter or an OpenAI-compatible gateway. Cursor's bring-your-own-key feature is IDE-chat-only.

```bash
export CURSOR_API_KEY=key_...     # from the Cursor dashboard
cursor-agent -p --force --model gpt-5 --output-format json 'fix the failing tests'
```

Without `-f/--force` (alias `--yolo`) it only _proposes_ changes and writes nothing — a silent no-op in a box you're about to destroy. `cursor-agent bedrock` configures AWS Bedrock, which is the one BYO-inference path that exists.

## Which agent can use which provider

|                | OpenRouter                            | Anthropic direct     | OpenAI direct | Generic OpenAI-compatible gateway                    | Anthropic-compatible gateway |
| -------------- | ------------------------------------- | -------------------- | ------------- | ---------------------------------------------------- | ---------------------------- |
| `claude`       | ✅ `/api`                             | ✅                   | ❌ wrong wire | ❌ wrong wire                                        | ✅ `ANTHROPIC_BASE_URL`      |
| `codex`        | ⚠️ `/api/v1` + `wire_api="responses"` | ❌ no Anthropic wire | ✅            | ❌ **Responses only** — Chat-Completions is rejected | ❌                           |
| `opencode`     | ✅ env var alone                      | ✅                   | ✅            | ✅ `@ai-sdk/openai-compatible`                       | ✅ `@ai-sdk/anthropic`       |
| `pi`           | ✅ built in                           | ✅ built in          | ✅ built in   | ✅ `models.json`                                     | ✅ `models.json`             |
| `cursor-agent` | ❌                                    | ❌                   | ❌            | ❌                                                   | ❌                           |

`opencode` and `pi` are the two that will talk to anything. ⚠️ on codex+OpenRouter: OpenRouter does serve `/api/v1/responses` and codex reaches it correctly, but how completely its Responses implementation supports codex's tool and streaming usage is not established here — try it on a small task before committing a long run to it.

## Restricting egress around an agent

An agent box holds a provider key and runs model-authored code, which is the case where egress restriction earns its keep. Presets:

| Preset          | Opens                                          |
| --------------- | ---------------------------------------------- |
| `-p openrouter` | `openrouter.ai`                                |
| `-p openai`     | `api.openai.com`                               |
| `-p anthropic`  | `api.anthropic.com`, `statsig.anthropic.com`   |
| `-p cursor`     | the `*.cursor.sh` / `downloads.cursor.com` set |

```bash
cos agent -p openrouter -m openai/gpt-5.6-luna -o . claude . 'fix the tests'
```

That box can reach the model provider and nothing else. The tension is real: the agent often needs `npm`/`pypi`/`github` to do the task you gave it, so compose the presets it actually needs (`-p openrouter -p npm`) rather than reaching for `-E`. Recall that domain rules take ~30 s to apply and are weak against cleartext HTTP — for an adversarial workload, IP/CIDR rules are the stronger control.

`cos agent` already sets each agent's telemetry and auto-update kill switches, so a provider-only allowlist doesn't hang on a background call.

## Traps

- **The box is root, and agents notice.** claude needs `IS_SANDBOX=1`; codex wants its own sandbox disabled because Landlock won't nest usefully. This is expected in a microVM, not a misconfiguration.
- **No `-o` means the work is destroyed with the box.** The most common way to waste a run.
- **`openrouter.ai/api` vs `openrouter.ai/api/v1`** — Anthropic-shaped vs OpenAI-shaped. Getting this wrong produces a 404 that names nothing useful.
- **A half-pinned claude model config fails late**, mid-run, on the first subagent call — not at startup where you'd notice.
- **An agent with a key and unrestricted egress can exfiltrate that key.** If the repo is untrusted, restrict egress to the provider; if it is actively hostile, don't put a real key in the box at all.
- **Don't quote these versions.** All five auto-update on their own release cadence, and codex has already changed its provider config contract once (`wire_api = "chat"` was removed). Re-check against the image before relying on a flag.
