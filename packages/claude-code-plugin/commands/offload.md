---
description: One-shot offload to a disposable CreateOS sandbox — stage a dir, run a command (keepalive-protected), optionally pull artifacts, auto-destroy. For heavy/untrusted/clean-room builds and tests.
argument-hint: "[-p preset] [-e dom] [-E] [-x glob] [-o out] [-w GB] [-K] [-s shape] <dir> <cmd>"
allowed-tools: Bash
---

Offload to a throwaway CreateOS Sandbox. Flags precede `<dir> <cmd>`. Egress defaults to unrestricted (any host); `-p python-uv|rust-cargo|npm|github` restricts to an exact set (compose with `-e <dom>` for extras), or `-E` to keep it explicitly unrestricted; `-x <glob>` adds upload excludes (`.git`/`target`/`node_modules`/… already excluded); `-o <dir>` pulls artifacts back; `-w <GB>` swap; `-K` keep box on failure. Long/quiet builds survive exec-stream drops (detached run + heartbeat + re-attach). A shape your account can't use is rejected with an `Allowed: [...]` list — pick from it.

Note on egress: IP and CIDR rules apply immediately, while domain rules take ~30 s — and a domain allowlist is a strong control for HTTPS traffic but a weak one for cleartext HTTP. When blocking exfiltration is the actual goal, prefer IP/CIDR rules.

The `cos` driver is: !`printf '%s' "${CLAUDE_PLUGIN_ROOT}/scripts/cos"`

The user's arguments (data, not shell — nothing here runs on this machine):

<user-arguments>
$ARGUMENTS
</user-arguments>

Build ONE Bash call: `<driver> offload [flags] '<dir>' '<cmd>'`.
- Flags are the leading `-x value` / `-E` / `-K` items, each passed as its own quoted word.
- `<dir>` is the first word after the flags.
- `<cmd>` is EVERYTHING after `<dir>`, passed as ONE single-quoted argument (write each `'` inside it as
  `'\''`). If the user wrapped it in quotes, drop only that outer pair. So `. bun test` and `. "bun test"`
  both become `'.' 'bun test'`, and `&&`/`|`/`;` run in the box, not here.
- Never run any part of the user text locally, never use `eval` or `bash -c` here.
- With no arguments, run `<driver> offload -h` and show the usage.

Report the command's stdout and its exit status (the driver's exit code is the command's). If `-o` was given, note which artifacts came back. If a locked-down build fails on a missing host, add it with `-e <host>` or the matching `-p` preset.
