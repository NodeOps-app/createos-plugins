---
description: Remote code execution — run untrusted code or any ad-hoc script/snippet (py, js, mjs, cjs, ts, go, sh, rb, c, cpp, rs) in a throwaway CreateOS box instead of on this machine. Timeout, optional stdin, real exit code, auto-destroys.
argument-hint: "[-l lang] [-i stdin-file] [-t secs] [-N] [-p preset] [-e dom] <file> [args...]"
allowed-tools: Bash
---

Run one source file in a disposable CreateOS Sandbox. Flags precede `<file>`; everything after `<file>` goes to the program untouched. Language comes from the extension (`-l` overrides). Egress is unrestricted by default; `-p`/`-e` allow just those hosts, `-N` blocks outbound connections. `-i` feeds a local file to stdin; `-t` is a wall-clock limit (default 120 s, exit 124 when hit).

!`if test -n "$ARGUMENTS"; then "${CLAUDE_PLUGIN_ROOT}/scripts/cos" exec $ARGUMENTS; else "${CLAUDE_PLUGIN_ROOT}/scripts/cos" exec; fi`

Report the program's stdout, stderr and the `cos: exit=N time=Ns` line above. Exit 124 means the timeout killed it.
