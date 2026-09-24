---
description: One-shot offload to a disposable CreateOS sandbox — stage a dir, run a command (keepalive-protected), optionally fetch artifacts, auto-destroy. For heavy/untrusted/clean-room builds and tests.
argument-hint: "[-p preset] [-e dom] [-E] [-x glob] [-o out] [-K] [-s shape] <dir> <cmd>"
allowed-tools: Bash
---

Offload to a throwaway CreateOS Sandbox. Flags precede `<dir> <cmd>`. Egress defaults to unrestricted (any host); `-p python-uv|rust-cargo|npm|github` restricts to an exact set (compose with `-e <dom>` for extras), or `-E` to keep it explicitly unrestricted; `-x <glob>` adds upload excludes (`.git`/`target`/`node_modules`/… already excluded); `-o <dir>` fetches a path back into the local dir; `-K` keep box on failure. Long/quiet builds survive exec-stream drops (detached run + heartbeat + re-attach). A shape your account can't use is rejected with an `Allowed: [...]` list — pick from it. Need swap for a heavy build? Compose it into the command itself: `'fallocate -l 4G /swapfile && mkswap /swapfile && swapon /swapfile && <cmd>'`.

Note on egress: IP and CIDR rules apply immediately, while domain rules take ~30 s — and a domain allowlist is a strong control for HTTPS traffic but a weak one for cleartext HTTP. When blocking exfiltration is the actual goal, prefer IP/CIDR rules.

!`test -n "$ARGUMENTS" && "${CLAUDE_PLUGIN_ROOT}/scripts/cos" offload $ARGUMENTS || "${CLAUDE_PLUGIN_ROOT}/scripts/cos" offload`

Report the command's stdout and exit status above. If `-o` was given, note which artifacts came back. If a locked-down build fails on a missing host, add it with `-e <host>` or the matching `-p` preset.
