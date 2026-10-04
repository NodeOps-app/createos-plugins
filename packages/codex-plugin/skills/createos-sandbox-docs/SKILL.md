---
name: createos-sandbox-docs
description: Answer questions about CreateOS Sandbox concepts, capabilities, CLI commands, SDKs, REST APIs, limits, lifecycle, networking, storage, or integrations using the official live documentation. Use when explaining the product or writing code that integrates with it.
---

# CreateOS Sandbox documentation

CreateOS Sandbox provides disposable Linux Firecracker microVMs. Beyond running
commands and transferring files, the product supports pause/resume/fork,
managed processes, previews and tunnels, private networks and VPN, S3-compatible
disks, custom images, and desktop control. Availability, API shapes, and limits
must be checked in the live docs.

Read the shared [docs index](../using-createos-sandbox/references/docs.md), then
fetch the relevant official `.md` pages using the host's web tools or
`curl -L --fail --silent <url>`. Fetch only the pages needed for the question.

- Product explanations: start with Overview or Concepts.
- Developer integration: use the SDK quickstart and the relevant SDK reference
  or REST endpoint page; confirm language-specific signatures before writing code.
- CLI usage: use the command reference. For plugin execution workflows, read
  `using-createos-sandbox` or `sandbox-jobs` instead.
- Quotas, shapes, timeouts, and defaults: check Limits and relevant endpoint docs
  rather than quoting remembered values or this plugin's local job limits.

If a page moved, fetch https://createos.sh/docs/llms.txt, find its `/Sandbox/`
entry, and resolve it under `https://createos.sh/docs` with `.md` appended.
If live docs cannot be fetched, explain that limitation; label local reference
information as potentially stale. Cite the official pages used in the answer.

Keep documented behaviour separate from this plugin's measured caveats in the
[offload and egress reference](../using-createos-sandbox/references/offload-and-egress.md)
and other shared references. If they conflict,
state the discrepancy, especially for egress enforcement; do not silently drop
the measured caveat.

Product support does not imply a dedicated MCP tool exists. This plugin exposes
local job tools; use the `cos` skill for other supported execution workflows.
Documentation questions require no sign-in or sandbox creation. For account
inventory, use `list_sandboxes`; distinguish those live account results from the
workspace's local `list_jobs` records.
