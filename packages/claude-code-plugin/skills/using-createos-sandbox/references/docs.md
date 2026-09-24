# CreateOS Sandbox docs — live index

Every CreateOS Sandbox docs page, as raw markdown. Use this when the question is
about the **product** — REST endpoints, SDK methods, CLI flags, limits, lifecycle,
egress semantics, integrations — rather than about driving `cos`.

**How to use:** pick the one or two pages that answer the question and fetch them
(`WebFetch`, or `curl -sL <url>`). Every URL below is `<page>.md` and returns
`text/markdown` — no HTML scraping needed. Do not fetch the whole list.

The docs are the source of truth and newer than this plugin. When a page
disagrees with `SKILL.md` or another reference file on a number or an API shape,
trust the page. Behaviour this plugin measured itself (egress enforcement, the
concurrency cap, OOM traps) stays in the other reference files.

If a URL 404s, the page moved: re-derive the list from
<https://createos.sh/docs/llms.txt> (lines under `/Sandbox/`) and append `.md`.

## Start here

- [Sandbox](https://createos.sh/docs/Sandbox.md) — landing page: what the product is for.
- [Overview](https://createos.sh/docs/Sandbox/Overview.md) — disposable Linux microVMs for untrusted code, AI agents, CI jobs, previews, networking, persistence, forking.
- [Quickstart](https://createos.sh/docs/Sandbox/Quickstart.md) — first sandbox with CLI, TypeScript SDK and REST side by side.
- [Concepts](https://createos.sh/docs/Sandbox/Concepts.md) — vocabulary: shapes, root filesystems, lifecycle state machine, pause and fork, private networks, egress rules, disks, templates.
- [Limits & defaults](https://createos.sh/docs/Sandbox/Limits.md) — shapes, disks, networks, timeouts, quotas.
- [Bring your own storage](https://createos.sh/docs/Sandbox/Bring-Your-Own-Storage.md) — snapshots and disks in your own S3 / R2 / MinIO / Tigris.
- [Run on your own infrastructure](https://createos.sh/docs/Sandbox/Self-Hosting.md) — self-hosted / on-prem data plane (alpha, enterprise).
- [Claude Managed Agents](https://createos.sh/docs/Sandbox/Claude-Managed-Agents.md) — run Claude Managed Agents inside sandboxes: setup, credentials, egress allowlist, cleanup.

## CLI

- [CLI](https://createos.sh/docs/Sandbox/CLI.md) — install, sign in, manage sandboxes from a terminal or CI.
- [Overview](https://createos.sh/docs/Sandbox/CLI/Overview.md) — create, exec, sync, tunnel, destroy.
- [Command Reference](https://createos.sh/docs/Sandbox/CLI/Commands.md) — every `createos sandbox` command and flag.
- [Sandboxes (CLI section)](https://createos.sh/docs/CLI/Sandbox.md) — `createos sandbox` / `sb` from the main CLI docs, including shell and tunnel.

## REST API

- [REST API](https://createos.sh/docs/Sandbox/REST-API.md) — index of resource groups.
- [Overview](https://createos.sh/docs/Sandbox/REST-API/Overview.md) — base URL, `X-Api-Key` auth, JSend envelope, rate behaviour.
- [Sandboxes](https://createos.sh/docs/Sandbox/REST-API/Sandboxes.md) — create / list / inspect / destroy: shapes, rootfs, create-time egress, auto-pause, envs, ingress, regions, status lifecycle.
- [Execution & Files](https://createos.sh/docs/Sandbox/REST-API/Execution-And-Files.md) — run commands (buffered or streamed), upload / download files and directories.
- [Managed Processes](https://createos.sh/docs/Sandbox/REST-API/Managed-Processes.md) — start, supervise, stop long-running processes.
- [Pause, Resume & Fork](https://createos.sh/docs/Sandbox/REST-API/Pause-Resume-Fork.md) — snapshot, restore, clone.
- [Egress](https://createos.sh/docs/Sandbox/REST-API/Egress.md) — open with no rules, deny-by-default with any rule, in-kernel enforcement, rule formats.
- [Networks](https://createos.sh/docs/Sandbox/REST-API/Networks.md) — private overlay networks, DNS names, limits.
- [Devices & VPN](https://createos.sh/docs/Sandbox/REST-API/Devices.md) — WireGuard devices into private networks.
- [Shell & Tunnels](https://createos.sh/docs/Sandbox/REST-API/Connections.md) — interactive shells and port tunnels.
- [Disks](https://createos.sh/docs/Sandbox/REST-API/Disks.md) — register S3-compatible disks, mount / detach on running sandboxes.
- [Templates](https://createos.sh/docs/Sandbox/REST-API/Templates.md) — custom rootfs from a Dockerfile: build status, limits.
- [Bandwidth & Resize](https://createos.sh/docs/Sandbox/REST-API/Bandwidth-And-Resize.md) — bandwidth budget check / recharge, shape resize.
- [Catalog & Identity](https://createos.sh/docs/Sandbox/REST-API/Catalog-And-Identity.md) — list shapes and root filesystems, whoami.
- [Sandbox access tokens](https://createos.sh/docs/Sandbox/REST-API/Access-Tokens.md) — delegated credential scoped to one sandbox: create, rotate, disable.
- [Self-Signal (In-Sandbox)](https://createos.sh/docs/Sandbox/REST-API/Self-Signal.md) — endpoints a sandbox calls on itself.
- [Metrics](https://createos.sh/docs/Sandbox/REST-API/Metrics.md) — per-sandbox CPU, memory, disk, network.
- [Webhooks](https://createos.sh/docs/Sandbox/REST-API/Webhooks.md) — lifecycle events, payload, retries, signature verification.
- [Computer](https://createos.sh/docs/Sandbox/REST-API/Computer.md) — screenshots, input events, desktop control.

## SDK — getting started

- [SDK](https://createos.sh/docs/Sandbox/SDK.md) — SDKs for TypeScript, Go, Python, Rust, C#, Java.
- [SDKs overview](https://createos.sh/docs/Sandbox/SDK/Overview.md) — install / create / run / files / cleanup in each language.
- [Quickstart](https://createos.sh/docs/Sandbox/SDK/Quickstart.md) — `@nodeops-createos/sandbox` in five minutes.
- [Tutorial](https://createos.sh/docs/Sandbox/SDK/Tutorial.md) — build a code-execution service: restrict egress, run untrusted code, collect output.
- [Examples](https://createos.sh/docs/Sandbox/SDK/Examples.md) — agent code execution, fork-based parallel rollouts, multi-sandbox networks.

## SDK — how-to

- [How-To Guides](https://createos.sh/docs/Sandbox/SDK/How-To.md) — index.
- [Upload & Download Files](https://createos.sh/docs/Sandbox/SDK/How-To/Files.md)
- [Pause, Fork & Auto-Pause](https://createos.sh/docs/Sandbox/SDK/How-To/Lifecycle.md)
- [Expose a Service](https://createos.sh/docs/Sandbox/SDK/How-To/Expose-A-Service.md)
- [Disks, Networks & Templates](https://createos.sh/docs/Sandbox/SDK/How-To/Disks-Networks-Templates.md)
- [Stream Command Output](https://createos.sh/docs/Sandbox/SDK/How-To/Streaming.md)
- [Error Handling](https://createos.sh/docs/Sandbox/SDK/How-To/Error-Handling.md)
- [Observability](https://createos.sh/docs/Sandbox/SDK/How-To/Observability.md)
- [Delegate access to one sandbox](https://createos.sh/docs/Sandbox/SDK/How-To/Sandbox-Access-Tokens.md) — sandbox access token for a worker.

## SDK — API reference (TypeScript)

- [API Reference](https://createos.sh/docs/Sandbox/SDK/Reference.md) — index.
- [Overview](https://createos.sh/docs/Sandbox/SDK/Reference/Overview.md)
- [Client](https://createos.sh/docs/Sandbox/SDK/Reference/Client.md)
- [Sandbox](https://createos.sh/docs/Sandbox/SDK/Reference/Sandbox.md)
- [Sandbox Files](https://createos.sh/docs/Sandbox/SDK/Reference/Sandbox-Files.md)
- [Sub-APIs](https://createos.sh/docs/Sandbox/SDK/Reference/Sub-APIs.md) — disks, networks, templates.
- [Managed Processes](https://createos.sh/docs/Sandbox/SDK/Reference/Managed-Processes.md)
- [Computer](https://createos.sh/docs/Sandbox/SDK/Reference/Computer.md)
- [Errors](https://createos.sh/docs/Sandbox/SDK/Reference/Errors.md)
- [Helpers](https://createos.sh/docs/Sandbox/SDK/Reference/Helpers.md)
- [Types](https://createos.sh/docs/Sandbox/SDK/Reference/Types.md)

## SDK — explanation

- [Concepts](https://createos.sh/docs/Sandbox/SDK/Explanation.md) — index.
- [VM Sandboxes](https://createos.sh/docs/Sandbox/SDK/Explanation/VM-Sandboxes.md) — why a Firecracker microVM, not a container.
- [The Handle Model](https://createos.sh/docs/Sandbox/SDK/Explanation/Handle-Model.md) — what the `Sandbox` handle caches and when it refreshes.
- [Sandbox Lifecycle](https://createos.sh/docs/Sandbox/SDK/Explanation/Lifecycle.md) — creating → running → pausing → paused → resuming → forking → destroying.
- [Reliability](https://createos.sh/docs/Sandbox/SDK/Explanation/Reliability.md) — retries, timeouts, partial state.

## Integrations

- [Integrations](https://createos.sh/docs/Sandbox/Integrations.md) — index.
- [Overview](https://createos.sh/docs/Sandbox/Integrations/Overview.md)
- [Claude Code](https://createos.sh/docs/Sandbox/Integrations/Claude-Code.md) — this plugin.
- [Codex](https://createos.sh/docs/Sandbox/Integrations/Codex.md)
- [OpenCode](https://createos.sh/docs/Sandbox/Integrations/OpenCode.md)
- [Pi](https://createos.sh/docs/Sandbox/Integrations/Pi.md)
- [Herdr](https://createos.sh/docs/Sandbox/Integrations/Herdr.md)
- [DeepSeek Harness](https://createos.sh/docs/Sandbox/Integrations/DeepSeek-Harness.md)
- [Orca](https://createos.sh/docs/Sandbox/Integrations/Orca.md)
- [n8n](https://createos.sh/docs/Sandbox/Integrations/n8n.md)
- [Langflow](https://createos.sh/docs/Sandbox/Integrations/Langflow.md)
- [AgentBox](https://createos.sh/docs/Sandbox/Integrations/AgentBox.md)
