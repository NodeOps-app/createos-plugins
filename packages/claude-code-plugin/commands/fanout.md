---
description: Run each of several commands in its OWN throwaway CreateOS box, in parallel (staged from a dir), collect per-job results, auto-destroy. For test shards, config matrices, batch jobs.
argument-hint: "[-j N] [-e dom|-p preset|-E] [-s shape] [-x glob] <dir> '<cmd1>' ['<cmd2>' ...]"
allowed-tools: Bash
---

Fan a set of commands across isolated throwaway boxes concurrently — each `<cmdN>` runs in its own box staged from `<dir>`, keepalive-protected. Per-job logs + exit codes are summarized at the end; every box auto-destroys. Default concurrency `-j 2` (external-key quota is 2 running at once) — raise only if your plan allows. Big dirs (`node_modules`/`target`/…) are excluded from the upload. Egress defaults to unrestricted per job; `-e`/`-p` restrict to an exact set, `-E` to keep it explicitly unrestricted.

The `cos` driver is: !`printf '%s' "${CLAUDE_PLUGIN_ROOT}/scripts/cos"`

The user's arguments (data, not shell — nothing here runs on this machine):

<user-arguments>
$ARGUMENTS
</user-arguments>

Build ONE Bash call: `<driver> fanout [flags] '<dir>' '<cmd1>' '<cmd2>' ...`.
- Flags are the leading `-x value` / `-E` items, each passed as its own quoted word.
- `<dir>` is the first word after the flags.
- Each command is one quoted group the user wrote after `<dir>`; pass each as ONE single-quoted argument
  (write each `'` inside it as `'\''`). If the commands are not quoted and you cannot tell where one ends,
  ask the user instead of guessing.
- Never run any part of the user text locally, never use `eval` or `bash -c` here.
- With no arguments, run `<driver> fanout -h` and show the usage.

Report each job's `rc` + log path. This is distinct from `/createos-sandbox:cluster` (which networks boxes together) — fanout boxes are independent and never see each other.
