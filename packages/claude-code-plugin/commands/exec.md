---
description: Remote code execution — run untrusted code or any ad-hoc script/snippet (py, js, mjs, cjs, ts, go, sh, rb, c, cpp, rs) in a throwaway CreateOS box instead of on this machine. Timeout, optional stdin, real exit code, auto-destroys.
argument-hint: "[-l lang] [-i stdin-file] [-t secs] [-N] [-p preset] [-e dom] <file> [args...]"
allowed-tools: Bash
---

Run one source file in a disposable CreateOS Sandbox. Flags precede `<file>`; everything after `<file>` goes to the program untouched. Language comes from the extension (`-l` overrides). Egress is unrestricted by default; `-p`/`-e` allow just those hosts, `-N` blocks outbound connections. `-i` feeds a local file to stdin; `-t` is a wall-clock limit (default 120 s, exit 124 when hit).

The `cos` driver is: !`printf '%s' "${CLAUDE_PLUGIN_ROOT}/scripts/cos"`

The user's arguments (data, not shell — nothing here runs on this machine):

<user-arguments>
$ARGUMENTS
</user-arguments>

Build ONE Bash call: `<driver> exec [flags] '<file>' [program args...]`.
- Flags are the leading `-x value` / `-N` items, each passed as its own quoted word.
- `<file>` is the first word after the flags.
- Program args are the remaining words, each single-quoted on its own (write each `'` inside one as
  `'\''`), keeping the user's own quoting/grouping. They go to the program in the box untouched.
- Never run any part of the user text locally, never use `eval` or `bash -c` here.
- With no arguments, run `<driver> exec -h` and show the usage.

Report the program's stdout, stderr and the `cos: exit=N time=Ns` line. Exit 124 means the timeout killed it.
