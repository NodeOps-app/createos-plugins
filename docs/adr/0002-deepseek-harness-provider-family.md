# ADR-0002 — CreateOS on DeepSeek Harness: a provider family, not a tool plugin

- **Status:** accepted
- **Date:** 2026-08-13
- **Applies to:** `packages/ds-extension` (`@createos/dsh`)

## Context

DeepSeek Harness (`deepseek-ai/deepseek-harness`) is a Cordis-based plugin
runtime. Every capability — tools, LLM adapters, filesystem, process execution —
is a plugin mounted on a shared context.

We already ship a CreateOS integration for the Pi harness
(`packages/pi-extension`). Pi has no execution-world seam, so that extension had
to intercept seven built-in tools and register 33 `sandbox_*` tools by hand.

DeepSeek Harness is different. It splits replaceable capabilities into three
roles — Service Definition, Service Provider, Consumer — and **filesystem
(`ctx.fs`) and process execution (`ctx.subprocess`) are already split that way**.
The harness ships `packages/e2b/`, a provider family that puts one execution
world in an E2B sandbox, whose README states plainly that `dsh-bash-local`,
`dsh-terminal-bash`, and `dsh-lsp-stdio` need no E2B-specific forks because they
delegate every execution-world operation to those two seams.

## Decision 1 — architecture

**Chosen: a provider family mirroring `packages/e2b/`.**

Options considered:

| Option                                | What it means                                                                                                                 | Verdict                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **A. Provider family (chosen)**       | Implement `ctx.createos` (lifecycle), `ctx.fs`, and `ctx.subprocess`. Every existing tool transparently executes in the sandbox. | Idiomatic for this harness; ~1500 LOC; zero tool forks; new upstream tools work automatically.                                        |
| B. Tool plugin (the pi-extension way) | Register explicit `createos_*` tools beside the local ones. The model must choose them.                                        | Rejected: shallower, duplicates work the seam already does, and leaves the agent's own files and processes on the user's machine.     |
| C. Provider family + CreateOS tools   | A, plus tools for CreateOS-only powers (HTTPS expose, fork, disks, egress, networks, tunnels).                                 | Deferred, not rejected. Those capabilities have no seam and will need tools eventually; they are additive to A rather than a rewrite. |

Consequence: the bundle patch disables `fs-sandbox` and `subprocess` rather than
layering over them. Cordis permits exactly one provider per service name, so a
second registration of `fs` or `subprocess` is a duplicate-service error, not a
fallback.

## Decision 2 — repository location

**Chosen: `packages/ds-extension/` in this repo**, beside
`packages/pi-extension/` and `packages/claude-code-plugin/`.

The alternative was a standalone public repo; the sibling directory
`../createos-sandbox-ds-plugin` had already been created (empty, not a git repo)
in anticipation of that. Keeping all three harness integrations in one repo
shares tooling, lint config, and CI, and matches how `pi-extension` is already
laid out. The empty sibling directory is now unused.

Note this package deliberately owns all three roles in **one** npm package with
three entry points, where the harness's own E2B family uses three packages. The
harness docs explicitly allow it ("a package may otherwise own more than one
role"); splitting is warranted only when the roles need to evolve or be replaced
independently, which they do not here — they all move together with CreateOS.

## Decision 3 — terminal/PTY scope

**Chosen: defer `spawnTerminal` to v2.** It throws a clear error naming the
limitation.

`SubprocessRuntime.spawnTerminal` is abstract, so the provider must define it.
The E2B reference implementation is 567 lines — the single largest chunk of that
family — and needs foreground-process-group inspection and signalling that
CreateOS does not expose directly.

This is deferred rather than blocked: CreateOS **does** ship a keyless PTY
(`POST /v1/sandboxes/{id}/shell` for a raw byte stream and
`GET /v1/sandboxes/{id}/shell-ws` for WebSocket), which is a viable transport for
both `spawnTerminal` and the `stdin: 'pipe'` mode that `dsh-lsp-stdio` needs.
Until then, PTY and bidirectional-stdio consumers must run against a local
subprocess provider.

## Control-plane constraints that shaped the implementation

These are properties of the CreateOS API, discovered while building, and are the
reason several parts of the provider look indirect:

1. **`POST /v1/sandboxes/{id}/exec` takes no working directory**, and its `env`
   map is an allowlist fixed at sandbox-create time — an undeclared key returns
   400. Both therefore ride in argv via `env -C <cwd> KEY=VAL ... <argv>`
   (GNU coreutils ≥ 8.28, present on every CreateOS rootfs).
2. **Exec is request-scoped**: no pid, no signal channel. Termination brands each
   spawn with an inherited `DSH_CREATEOS_SPAWN` variable and signals every
   process still carrying it by scanning `/proc/*/environ`. Because the marker is
   inherited, this is tree-scoped by construction — an orphaned grandchild is
   still reachable — and needs no pidfile.
3. **The files endpoint moves bytes but exposes no metadata.** Target identity,
   type, size, and the freshness token come from `stat`, `realpath -mz`, and
   `find -printf` run through exec. Caller data is always bound to positional
   parameters (`$1`, `$2`, …) so a path can never be re-parsed as shell syntax.
4. **No stdin stream.** Batch `{ data }` stdin is staged as a file and redirected
   by a fixed wrapper; `'pipe'` cannot be honoured (see Decision 3).

## Composing against `dsh-base`: four things swapping the providers is not enough for

Replacing `ctx.fs` and `ctx.subprocess` moves the execution world, but four base
rows still assume that world is local. Each was found by running a real agent
loop; none is visible to a typecheck, a unit test, or `--dump-config`.

1. **`sandbox` must stay enabled.** `dsh-bash-sandbox` *injects* `sandbox`, so
   disabling `dsh-sandbox-local` strands the shell chain — `bash-sandbox` never
   provides `shell`, and `dsh-tool-bash` plus `dsh-permission-presets` sit in
   PENDING until boot fails with "3 entries did not activate".
2. **`sandbox-policy.mode` must be `danger-full-access`.** `bash-sandbox`
   short-circuits to `ctx.subprocess` only in that mode; otherwise it resolves a
   *host* confinement backend and wraps argv in it — a macOS host builds a
   `sandbox-exec …` argv that is then executed inside a Linux sandbox and dies
   with `exec: sandbox-exec: not found`. With no usable host backend it refuses
   to run at all rather than run unconfined. This is not a loosening: the
   isolation boundary moved from Seatbelt/Landlock to the CreateOS microVM.
3. **`permission.defaultPreset` must be named explicitly.** The preset service
   matches the composed (sandbox, approval) defaults against its table; the base
   pairs `danger-full-access` with `approval: never`, so changing only the mode
   matches no preset and the service fails the load.
4. **The sandbox cwd must mirror the host cwd.** The harness seeds each
   session's workspace root from `process.cwd()`, and `dsh-tool-bash` resolves
   `workdir` from that root, so a sandbox rooted at `/root/workspace` makes the
   agent's first command fail to chdir (`env -C` exits 125) and the model
   improvise a fallback like `/tmp`. The runtime therefore defaults `cwd` to
   `process.cwd()` and creates that path in the sandbox.

A general lesson for the next provider family: a patch **replaces a row's whole
`config`**, so overriding one key silently drops its siblings — pinning
`bash-sandbox.cwd` dropped the base's `timeoutMs: 60000` until it was restated.

## Verification

`bun run typecheck` compiles the providers against the published
`@deepseek-ai/dsh-fs` and `@deepseek-ai/dsh-subprocess` abstract classes under
the harness's own `exactOptionalPropertyTypes` strictness. A contract drift in a
future release fails there first. `bun test` covers the collected-output offset,
truncation, and spill-discard logic, which has no network dependency and is the
easiest part to break silently.

Published versions in use: `dsh-fs` and `dsh-subprocess` `0.1.0-rc.6`, `cordis`
`4.0.1`, `schemastery` `3.18.1`. The in-repo harness source is versioned
`0.1.0-rc.5`, which was never published; `rc.6` is the closest released
contract and is what this package compiles against.

End-to-end confirmed against `@deepseek-ai/dsh@0.1.0-rc.6` with the headless
profile: a DeepSeek agent ran `pwd` and `uname -a` through `dsh-tool-bash`
(→ `bash-sandbox` → `ctx.subprocess`) and wrote and read a file through
`dsh-tool-fs` (→ `ctx.fs`). `uname -a` returned
`Linux … 6.12.95 … x86_64 GNU/Linux` from the sandbox, and the written file was
verified **absent on the host** — the proof the execution world actually moved.
The sandbox was destroyed on session end with no orphan left behind.

The verification ladder, cheapest first, is: typecheck (contract drift) → unit
tests (`CollectedStream`) → **`src/bundle.test.ts` (the composition layer)** →
`bun run smoke` (providers against a real sandbox, bare Cordis context) →
`--dump-config` → a real agent loop.

`bundle.test.ts` was added after reviewing
[`@tensorlake/dsh-sandbox`](https://github.com/tensorlakeai/dsh-tensorlake-sandbox),
an independent provider family for the same seams, whose `tests/bundle.spec.ts`
demonstrated the technique: load `cordis.patch.yml` with the loader's own
`entryListSchema`, run `applyEntryPatches` over a synthetic `dsh-base` entry
list, and assert the composed result — offline, in milliseconds. It asserts the
patch's `warnings` array is empty, which catches a row whose `id` matches
nothing; such a row is a silent no-op at boot and otherwise only shows up as
inexplicable runtime behavior. Every one of the four composition issues above is
now covered there, so the expensive agent-loop rung is a confirmation rather
than the discovery mechanism.

That review also corrected two things in this bundle:

- **`approval` must be overridden explicitly.** The base derives it from
  `DSH_PERMISSION_MODE`, so with that variable unset the approval service stayed
  `ask` while `defaultPreset` said `danger-full-access`. Headless hid the
  mismatch (no approval channel); the Web/TUI surface would prompt, or fail with
  "escalation requires approval, but no approval channel is available".
- **Only the `danger-full-access` preset is offered.** `read-only` and
  `workspace-write` describe *host* filesystem confinement and cannot describe a
  microVM boundary — selecting one asks the bash executor to re-engage a host
  backend that is unavailable here, so it refuses to run. Offering a mode that
  cannot work is a dishonest surface.

Additionally `bash-sandbox` and `tool-bash` are re-enabled unconditionally: the
base disables both on `win32`, which is correct for a local execution world and
wrong for a remote Linux one, where the host platform is irrelevant.
