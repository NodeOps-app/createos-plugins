---
description: Fanout with a shared setup step — build one box, run a command once on it, fork it once per job, run each job on its own clone. For a test-shard matrix that all need the same dependency install.
argument-hint: "[-P setup] [-F box] [-j N] [-e dom|-p preset|-E] [-s shape] [-x glob] <dir> <cmd1> [cmd2] ..."
allowed-tools: Bash
---

Fanout, plus one thing: `-P '<cmd>'` runs once on the golden box — the dependency install, the toolchain prep — before it forks once per `<cmdN>`. Reach for this the moment two or more jobs would otherwise repeat the same setup; the setup is paid once, not once per job. `-F <box>` skips staging a directory and forks an existing sandbox you already prepared and paused yourself, instead. `-j` defaults to 10, matching this account's observed running quota. Big dirs (`node_modules`/`target`/…) are excluded from the upload. Egress defaults to unrestricted per job; `-e`/`-p` restrict to an exact set, `-E` to keep it explicitly unrestricted.

!`test -n "$ARGUMENTS" && "${CLAUDE_PLUGIN_ROOT}/scripts/cos" matrix $ARGUMENTS || "${CLAUDE_PLUGIN_ROOT}/scripts/cos" matrix`

Report each job's `rc` + log path above, plus whether the golden box was destroyed (default) or kept (`-G`). Two known limits carry over from `createos sandbox matrix --help`: a fork does not carry the golden box's S3 disk attachments, and a clone whose snapshot isn't cached on the target host can take 11-13 s to resume rather than the usual sub-second. If the jobs have nothing in common, `/createos-sandbox:fanout` is the simpler tool for the same shape of work.
