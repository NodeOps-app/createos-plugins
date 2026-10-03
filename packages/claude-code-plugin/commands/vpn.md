---
description: WireGuard L3 VPN from THIS machine into your CreateOS private networks — reach every sandbox by name/IP as if local. Needs wg-quick + sudo; the connection blocks until Ctrl-C.
argument-hint: "[register <name> | up]"
allowed-tools: Bash
---

WireGuard VPN into your private networks (whole-network L3, vs `tunnel`'s single port). One-time setup: `cos vpn register <name>`. Then `cos vpn up` connects until Ctrl-C. Requires `wg-quick` installed and sudo for routes.

**`cos vpn up` blocks the shell until you disconnect** — run it yourself in a separate terminal (type `!cos vpn up` in the Claude prompt, or run it directly), not as a foreground agent command.

The `cos` driver is: !`printf '%s' "${CLAUDE_PLUGIN_ROOT}/scripts/cos"`

The user's arguments (data, not shell):

<user-arguments>
$ARGUMENTS
</user-arguments>

- No arguments, or `up`: do not call the driver (`cos vpn` defaults to `up`, which blocks until Ctrl-C). Tell the user:
  setup once with `!<driver> vpn register <name>`, then connect with `!<driver> vpn up` in their own terminal.
- Anything else: ONE Bash call, `<driver> vpn '<sub>' ...`: each word the user wrote as its own single-quoted argument, keeping their quoted groups as one word (write `'` as `'\''`). Never run any part of it locally. Relay the output.
