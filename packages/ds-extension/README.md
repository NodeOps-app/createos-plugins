# @createos/dsh

DeepSeek Harness provider family that moves the agent's **execution world** into
a remote [CreateOS Sandbox](https://nodeops.network/createos). The harness keeps
running locally; its files and processes live in the sandbox.

## Why this is three providers and not thirty tools

DeepSeek Harness splits every replaceable capability into a Service Definition,
a Service Provider, and a Consumer. Filesystem and process execution are already
split that way, so a provider swap relocates the whole execution world:

```text
dsh-tool-bash ─┐
dsh-tool-fs    ├─ inject ctx.fs / ctx.subprocess ──▶ @createos/dsh ──▶ CreateOS Sandbox
dsh-lsp-stdio ─┘                                       (this package)
```

`dsh-tool-bash`, `dsh-tool-fs`, `dsh-tool-fs-search`, and
`dsh-tool-str-replace-editor` are **not forked**. They delegate every
execution-world operation to `ctx.fs` and `ctx.subprocess`, so replacing those
two providers is what puts their work inside the sandbox. This mirrors the
harness's own `packages/e2b/` family.

| Entry point                | ctx key          | Role                                                            |
| -------------------------- | ---------------- | --------------------------------------------------------------- |
| `@createos/dsh`            | `ctx.createos`   | Owns one sandbox, shares the SDK handle, releases it on disposal |
| `@createos/dsh/fs`         | `ctx.fs`         | Filesystem seam over the CreateOS files + exec endpoints        |
| `@createos/dsh/subprocess` | `ctx.subprocess` | Process seam over the CreateOS NDJSON exec stream               |

## Install

```sh
dsh plugin --profile <name> add @createos/dsh
export CREATEOS_SANDBOX_API_KEY=...
dsh --profile <name>
```

Local development against a checkout:

```sh
pnpm dsh web --patch ./packages/ds-extension/cordis.patch.yml
```

Verify the composition before booting with `dsh --profile <name> --dump-config`.

## Configuration

The bundle patch reads the environment so a profile needs no YAML edits.

| Env var                     | Config key      | Default            |
| --------------------------- | --------------- | ------------------ |
| `CREATEOS_SANDBOX_API_KEY`  | (SDK-owned)     | required           |
| `CREATEOS_SANDBOX_BASE_URL` | (SDK-owned)     | production         |
| `CREATEOS_SHAPE`            | `shape`         | `s-2vcpu-2gb`      |
| `CREATEOS_ROOTFS`           | `rootfs`        | host default       |
| `CREATEOS_CWD`              | `cwd`           | the host's `process.cwd()`, mirrored in the sandbox |
| `CREATEOS_SANDBOX_ID`       | `sandboxId`     | create a new one   |
| `CREATEOS_INGRESS`          | `ingress`       | `false`            |
| `CREATEOS_DISPOSE`          | `disposeAction` | `destroy`          |

`disposeAction` is `destroy`, `pause`, or `keep`. A sandbox attached by
`sandboxId` is borrowed, never destroyed — `destroy` degrades to `pause` for it.

`cwd` mirrors the host working directory by design: the harness seeds each
session's workspace root from `process.cwd()` and `dsh-tool-bash` resolves
`workdir` from that root, so a sandbox rooted elsewhere makes the agent's first
command fail to chdir. Set `CREATEOS_CWD` only if you also pin the session
workspace to the same path.

**The bundle sets the agent to `danger-full-access` with `approval: never`.**
That is the intended posture for a remote execution world — the microVM is the
trust boundary rather than Seatbelt/Landlock — but it does mean no per-command
prompts inside the sandbox. Restrict `egress` for untrusted work. See
[ADR-0002](../../docs/adr/0002-deepseek-harness-provider-family.md) for why each
base row had to change.

The API key is read by the SDK in the harness process and is never forwarded
into the sandbox.

## What the CreateOS control plane does and does not give us

The exec endpoint returns `{cmd, args}` output over NDJSON. It carries **no
working directory, no per-call environment, no pid, and no signal channel**, and
the CreateOS files endpoint moves bytes but exposes no metadata. Three
consequences run through the whole package:

- **cwd and environment ride in argv.** Every spawn is wrapped in
  `env -C <cwd> KEY=VAL ... <argv>`. The endpoint's own `env` map is an
  allowlist fixed at sandbox-create time, so it cannot carry per-call values.
  Needs GNU coreutils ≥ 8.28, which every CreateOS rootfs ships.
- **Termination is marker-based.** Each spawn is branded with an inherited
  `DSH_CREATEOS_SPAWN` variable; terminating scans `/proc/*/environ` and signals
  everything still carrying it. That is tree-scoped by construction, so an
  orphaned grandchild is still reachable.
- **File metadata comes from `stat`, `realpath`, and `find`** run through exec,
  with caller data always bound to positional parameters so a path can never be
  re-parsed as shell syntax.

## Current limitations

| Limitation                        | Effect                                                                    |
| --------------------------------- | ------------------------------------------------------------------------- |
| `spawnTerminal` throws            | PTY consumers (`dsh-terminal-bash`) are unsupported; run them locally     |
| `stdin: 'pipe'` throws            | Bidirectional-stdio consumers (`dsh-lsp-stdio`) are unsupported           |
| `pid` is `0`                      | The guest pid is not observable through exec; `-1` still means spawn failed |
| Spill files publish at exit       | A truncated stream has no spill file until the process settles            |
| `streamText` buffers              | The files endpoint returns whole bodies, so large reads are buffered      |

CreateOS does expose a keyless PTY (`POST /v1/sandboxes/{id}/shell` and
`GET /shell-ws`), so the terminal seam is implementable — it is deferred, not
blocked. See [ADR-0002](../../docs/adr/0002-deepseek-harness-provider-family.md).

## Testing locally

Four layers, cheapest first. The first three need no network.

```sh
bun install
bun run typecheck   # tsc against the real harness contracts
bun test            # CollectedStream logic + the cordis.patch.yml composition
bun run check       # oxlint + oxfmt
bun run build       # emit lib/
```

`src/bundle.test.ts` is the rung that guards this bundle's riskiest surface. It
layers `cordis.patch.yml` over a synthetic `dsh-base` entry list using the
loader's own `applyEntryPatches`, offline, and asserts both the composed result
and that the patch produced **no warnings** — a row whose `id` matches nothing is
a silent no-op at boot. Run it after any patch edit; it catches in milliseconds
what otherwise only surfaces in a live agent loop.

`bun run typecheck` is the contract gate: it compiles the providers against the
published `FileSystem` and `SubprocessRuntime` abstract classes under the
harness's own `exactOptionalPropertyTypes` strictness, so drift in a new
`dsh-fs` / `dsh-subprocess` release fails here first.

### 1. End-to-end against a real sandbox (no harness, no LLM key)

```sh
bun run smoke
```

Drives the three providers through a bare Cordis context — `new Context()`,
mount, `ctx.inject([...])` — so it exercises exactly the seam methods `dsh`
would call and nothing else. It creates one sandbox, runs 21 checks
(`resolveExecutable`, collected stdout, cwd, per-spawn env, non-zero exit,
`terminate()` and tree liveness, `resolve`/`write`/`stat`/`read`/`edit`/
`listDir`, a stale-version guard, and a cross-provider check that a file the fs
provider wrote is readable by a spawned process), then destroys it.

The API key comes from `CREATEOS_SANDBOX_API_KEY`, falling back to
`~/.createos/config.json` — so `createos login` is enough. Override the shape
with `CREATEOS_SHAPE` (default `s-0.5vcpu-1gb`).

This is the layer that catches provider bugs a typecheck cannot: it is how the
`command -v` builtin bug was found (`command -v echo` reports the shell builtin,
not `/bin/echo`, so bare-name lookup now scans PATH for an executable file).

### 2. Inside the real harness (verified)

`cordis.patch.yml` names the package (`@createos/dsh`), so Node has to be able
to resolve it. Install the local checkout into a profile:

```sh
npx @deepseek-ai/dsh plugin --profile createos add /abs/path/to/packages/ds-extension
npx @deepseek-ai/dsh --profile createos --dump-config    # verify the layer applied
CREATEOS_SANDBOX_API_KEY=... npx @deepseek-ai/dsh --profile createos web
```

`--dump-config` needs no key and no model: it prints the composed configuration,
which is how you confirm the bundle inserted `createos` / `fs-createos` /
`subprocess-createos` and disabled `fs-sandbox` / `subprocess`.

A plain `--patch ./cordis.patch.yml` overlay against a source checkout will
**not** work until the package is resolvable by name — that flow is for patches
whose rows point at relative source paths.

Once booted, ask the agent to run `uname -a` or `pwd`: the answer comes from the
sandbox, not your machine.

Confirmed against `@deepseek-ai/dsh@0.1.0-rc.6`: `plugin add` appends
`@createos/dsh` to the profile's `dsh.profile.bundles` automatically (from the
`dsh.bundle` manifest), `--dump-config` shows `subprocess` and `fs-sandbox`
carrying `disabled: true` alongside the three inserted rows, and a live boot
registers `ctx.createos` / `ctx.fs` / `ctx.subprocess`, creates the sandbox, and
runs commands in it (`uname -a` → `Linux … x86_64`).

Two traps when driving a boot from a script:

- **Do not build the API key with `$(python3 …)`** if a wrapper prints banners to
  stdout — the banner is captured with the key and the SDK rejects the
  multi-line value with `TypeError: Headers.set`, echoing the key into the log.
  Read the file directly, as `scripts/smoke.ts` does.
- A probe plugin that calls `process.exit()` **skips Cordis disposal**, so the
  sandbox is not destroyed. Dispose the fiber, or clean up afterwards.
