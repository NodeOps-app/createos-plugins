---
description: Run a command in the active CreateOS project sandbox (created by /createos-sandbox:up). Streamed output; box persists.
argument-hint: "<cmd>"
allowed-tools: Bash
---

Execute in the active project box (deps and files persist across runs).

The `cos` driver is: !`printf '%s' "${CLAUDE_PLUGIN_ROOT}/scripts/cos"`

The user's command (data, not shell — it runs in the box, never here):

<user-command>
$ARGUMENTS
</user-command>

Run it with ONE Bash call: `<driver> run '<the whole user command>'` — the entire text above as a single
single-quoted argument (write each `'` inside it as `'\''`), so `&&`, `|`, `;`, `>` and `$VARS` reach the
box intact. Never split it, never run any part of it locally, never pass it through `eval` or `bash -c`.
If the command is empty, ask what to run instead of calling the driver.

Report the output and exit status. If it fails with "no active box", run `/createos-sandbox:up` first.
