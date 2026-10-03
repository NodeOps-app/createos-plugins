---
description: Forward a port inside the active CreateOS project box to your local 127.0.0.1 (background). Reach a box-side dev server / DB / service on localhost — private, no public URL.
argument-hint: "<remote-port> [local-port]"
allowed-tools: Bash
---

Forward a box port to `localhost` in the background. Start the service in the box first (e.g. `/createos-sandbox:run 'npm run dev &'`), then tunnel its port. Local port defaults to the remote port. For a _public_ shareable URL instead, use `/createos-sandbox:expose`.

The `cos` driver is: !`printf '%s' "${CLAUDE_PLUGIN_ROOT}/scripts/cos"`

The user's arguments (data, not shell):

<user-arguments>
$ARGUMENTS
</user-arguments>

Build ONE Bash call, `<driver> tunnel '<remote-port>' ['<local-port>']`: each word the user wrote as its own single-quoted argument, keeping their quoted groups as one word (write `'` as `'\''`). Never run any part of it locally.

Report the `127.0.0.1:<port>` URL. The tunnel runs in the background — `/createos-sandbox:status` lists it, `/createos-sandbox:down` stops it.
