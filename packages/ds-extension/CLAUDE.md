# @createos/dsh

DeepSeek Harness provider family for [CreateOS Sandbox](https://nodeops.network/createos).
Moves the agent's filesystem and process execution into a remote sandbox; the
harness itself keeps running locally.

Read [ADR-0002](../../docs/adr/0002-deepseek-harness-provider-family.md) before
reworking anything here — it records why this is a provider family rather than a
tool plugin, and the CreateOS API constraints that shaped the implementation.

## Architecture

SDK-only — operations go through `@nodeops-createos/sandbox`. No bespoke HTTP
client. Three plugin entry points in one package:

| Entry point                | ctx key          | File                |
| -------------------------- | ---------------- | ------------------- |
| `@createos/dsh`            | `ctx.createos`   | `src/index.ts`      |
| `@createos/dsh/fs`         | `ctx.fs`         | `src/fs.ts`         |
| `@createos/dsh/subprocess` | `ctx.subprocess` | `src/subprocess.ts` |

`src/exec.ts` holds the shared exec primitives and the fixed shell scripts;
`src/output.ts` holds the bounded collected-output reader.

The upstream reference is `packages/e2b/` in `deepseek-ai/deepseek-harness` —
the same three roles over a different sandbox provider. When in doubt about a
seam's intent, read the E2B implementation of the same method.

## The rule that makes this work

Consumers (`dsh-tool-bash`, `dsh-tool-fs`, `dsh-tool-fs-search`,
`dsh-tool-str-replace-editor`) are **never forked**. They inject `ctx.fs` and
`ctx.subprocess` by name, so replacing those two providers relocates their work.
If you find yourself writing a CreateOS-specific tool to do something a
consumer already does, stop — the seam is the mechanism.

## CreateOS control-plane constraints

Four API facts explain most of the indirection in this package:

1. **No cwd, no per-call env.** `POST /exec` takes `{cmd, args}`; its `env` map
   is an allowlist fixed at create time. Both ride in argv:
   `env -C <cwd> KEY=VAL ... <argv>`. Needs GNU coreutils ≥ 8.28.
2. **No pid, no signal channel.** Each spawn is branded with an inherited
   `DSH_CREATEOS_SPAWN` marker; `terminate()` scans `/proc/*/environ` and signals
   everything carrying it. Inheritance is what makes this tree-scoped.
3. **No file metadata API.** `stat`, `realpath -mz`, and `find -printf` run
   through exec supply identity, type, size, and the version token.
4. **No stdin stream.** Batch `{ data }` stdin is staged as a file;
   `stdin: 'pipe'` throws.

## Shell-script safety rule

Every script in this package is a **constant**; caller data is always passed as
positional parameters (`execScript(sandbox, SCRIPT, [path, mode])` → `$1`, `$2`).
Never interpolate a path, filename, or environment value into script text — a
filename containing `;` or `$(...)` would otherwise become shell syntax.

## Not implemented (deliberately)

- `spawnTerminal` throws. CreateOS has a keyless PTY (`POST /shell`,
  `GET /shell-ws`) so it is implementable; it was scoped out of v1.
- `stdin: 'pipe'` throws, so `dsh-lsp-stdio` is unsupported. Same PTY transport
  would unblock it.
- `pid` reports `0` (unknown) while running; `-1` still means the spawn failed.
- Spill files are uploaded once the process settles, not during the run.

## Verification

```sh
bun run typecheck   # the real gate — compiles against the published abstract classes
bun test            # CollectedStream offset / truncation / spill logic
bun run check       # oxlint + oxfmt
bun run build       # emit lib/
```

`typecheck` is what catches upstream contract drift: it compiles the providers
against the published `FileSystem` and `SubprocessRuntime` under the harness's
own `exactOptionalPropertyTypes` strictness. Bump `dsh-fs` / `dsh-subprocess`
and run it first.

## Adding a capability

1. Check whether an existing seam already covers it — if a consumer injects
   `ctx.fs` or `ctx.subprocess`, there is nothing to add here.
2. CreateOS-only powers (HTTPS expose, fork, disks, egress, networks, tunnels)
   have no seam and would need a fourth entry point registering tools. That is
   option C in ADR-0002 and is additive, not a rewrite.
