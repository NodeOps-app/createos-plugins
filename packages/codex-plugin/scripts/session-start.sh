#!/usr/bin/env bash
# session-start hook — publish the absolute path of the `cos` driver into context.
#
# Mirrors claude-code-plugin/scripts/session-start.sh (same ADR-0001 reasoning,
# same wire format: Codex parses `hookSpecificOutput.additionalContext` exactly
# like Claude Code does, so plain stdout is discarded and the agent is left with
# no driver path at all). Two things differ, and only two:
#
#   1. Resolve `cos` relative to this script, so it also works outside a hook.
#      Current Codex plugin hooks set PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT.
#      The driver next to it is a real copy of the canonical
#      claude-code-plugin/scripts/cos, written by scripts/sync-shared.sh —
#      symlinks are not an option, the Codex installer copies regular files only.
#   2. Do not assume plugin hook variables exist in agent shell calls.
set -euo pipefail

cos="$(cd "$(dirname "$0")" && pwd)/cos"
plugin_root="$(cd "$(dirname "$0")/.." && pwd)"

command -v jq >/dev/null 2>&1 || exit 0

# A missing or non-executable driver is exactly the case the fail-closed rule
# exists for, so it must still be stated — exiting quietly here would leave the
# agent with no driver AND no instruction, which is how the original fail-open
# happened. Say it plainly instead.
if [ ! -x "$cos" ]; then
  jq -nc --arg m "[createos-sandbox] The sandbox driver is MISSING or not executable at: $cos
Do not attempt sandbox work. Do NOT substitute raw \`createos sandbox\` primitives — that drops egress restriction, keepalive, auto-destroy and the auth preflight. Tell the user the plugin looks broken and stop." \
    '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$m}}'
  exit 0
fi

if command -v cos >/dev/null 2>&1; then
  where="\`cos\` is already on PATH — call it bare."
else
  where="\`cos\` is NOT on PATH. Call it by this absolute path, or run \`$cos install\` once to symlink it into ~/.local/bin."
fi

# Onboarding runs first so the agent knows up front whether the CLI is
# installed and signed in, instead of finding out mid-task. `setup` never
# prompts; a signed-out user gets browser sign-in started for them.
cli_status=$("$cos" setup 2>&1 || true)

# The verb rule lives here, not only in the skill. Measured behaviour: on an
# autonomous "run this off my machine" task the model reaches straight for the
# shell and never invokes the skill, so SKILL.md's guidance is not in context
# when the decision is made. It then picks `up`+`run` and hand-rolls tar/base64
# staging — work `offload` already does.
msg="[createos-sandbox] CreateOS CLI status:
$cli_status

The sandbox driver is at: $cos
$where
The plugin also provides MCP tools for durable jobs: start_job, get_job, get_job_logs, and download_artifact. Read the sandbox-jobs skill for that workflow. Use open_jobs to show the job panel when the host supports MCP Apps. The MCP job API defaults to denied outbound access and reports retained sandboxes explicitly.
For CreateOS Sandbox product, CLI, SDK, REST API, limits, or integration questions, read the createos-sandbox-docs skill at: $plugin_root/skills/createos-sandbox-docs/SKILL.md
The shared live docs index is at: $plugin_root/skills/using-createos-sandbox/references/docs.md
Fetch only the relevant official markdown pages; refresh moved links from https://createos.sh/docs/llms.txt. Documentation questions do not require sign-in or creating a sandbox. Use list_sandboxes for live account inventory; list_jobs is only local workspace job history.
If the driver cannot be run, stop and say so; do not substitute raw \`createos sandbox\` primitives, which drop egress restriction, keepalive, auto-destroy, and the auth preflight.

Picking the verb (get this right before running anything):
- Work with a finish line — run a test suite, a build, a script: \`cos offload <dir> '<cmd>'\`. ONE command. It creates the box, ships <dir> for you, runs, and destroys the box. Do NOT tar, base64, or push files in by hand, and do NOT use \`cos up\` for this.
- Work that must outlive one command — a dev server you'll hit repeatedly, a watcher, a multi-command session: \`cos up\`, then \`cos run\`, then \`cos pause\` or \`cos down\`.
- \`cos run\` takes the command as one plain string; there is no \`--\` separator. Run \`$cos help\` for the full verb list, and read the using-createos-sandbox skill before anything involving egress restriction, networking, or file sync."

jq -nc --arg m "$msg" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$m}}'
