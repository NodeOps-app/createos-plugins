---
description: Snapshot the active CreateOS project box and fork it into one or more independent clones (pauses briefly, then resumes). For branching experiments from identical warm state.
argument-hint: "[-c N]"
allowed-tools: Bash
---

Pause the project box, fork its snapshot into N new independent sandboxes (`-c N`, default 1; each auto-resumes), then resume the project box. Every clone starts from identical state and diverges from there. Clones are **not** tracked as the project box — so `cos down` will not destroy them — but each is recorded in the statefile, listed by `cos status`, and reaped by `cos down -f`.

!`test -n "$ARGUMENTS" && "${CLAUDE_PLUGIN_ROOT}/scripts/cos" fork $ARGUMENTS || "${CLAUDE_PLUGIN_ROOT}/scripts/cos" fork`

Report the fork id(s) above and remind the user to `createos sandbox rm -y <id>` (or `cos down -f`) when done — clones count against the account's running quota. Running the SAME job N ways from a directory rather than the project box is usually a better fit for `/createos-sandbox:matrix`.
