---
description: Give the active CreateOS project box a public HTTPS URL for one port. Stable link for the box's lifetime — good for sharing a live preview or webhook target.
argument-hint: "<port>"
allowed-tools: Bash
---

Enable public ingress and print the HTTPS URL for `<port>`. The service **must bind `0.0.0.0:<port>`** (not `127.0.0.1`) — ingress forwards to the box's external interface. The URL stays live while the box does. Revoke with `/createos-sandbox:unexpose`. For a private, local-only link use `/createos-sandbox:tunnel`.

The `cos` driver is: !`printf '%s' "${CLAUDE_PLUGIN_ROOT}/scripts/cos"`

The user's arguments (data, not shell):

<user-arguments>
$ARGUMENTS
</user-arguments>

Build ONE Bash call, `<driver> expose '<port>'`: each word the user wrote as its own single-quoted argument, keeping their quoted groups as one word (write `'` as `'\''`). Never run any part of it locally.

Report the URL and flag to the user that **anyone with the link can reach it** — don't expose services that assume a private network.
