---
description: Run each of several commands in its OWN throwaway CreateOS box, in parallel (staged from a dir), collect per-job results, auto-destroy. For test shards, config matrices, batch jobs.
argument-hint: "[-j N] [-e dom|-p preset|-E] [-s shape] [-x glob] <dir> <cmd1> [cmd2] ..."
allowed-tools: Bash
---

Fan a set of commands across isolated boxes concurrently — `<dir>` is staged once, forked once per `<cmdN>`, keepalive-protected. Per-job logs + exit codes are summarized at the end; every fork auto-destroys. Default concurrency 10, matching this account's observed running quota — raise only if your plan allows. Big dirs (`node_modules`/`target`/…) are excluded from the upload. Egress defaults to unrestricted per job; `-e`/`-p` restrict to an exact set, `-E` to keep it explicitly unrestricted.

!`test -n "$ARGUMENTS" && "${CLAUDE_PLUGIN_ROOT}/scripts/cos" fanout $ARGUMENTS || "${CLAUDE_PLUGIN_ROOT}/scripts/cos" fanout`

Report each job's `rc` + log path above. This is distinct from `/createos-sandbox:cluster` (which networks boxes together) — fanout boxes are independent and never see each other. If every job shares the same setup (a dependency install, a toolchain), `/createos-sandbox:matrix` runs that setup once instead of paying it per job.
