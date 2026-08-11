# Pi Startup Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add extension-only `--sync-once` and `--watch` startup modes that copy the host project to `/root/workspace` or maintain an existing Mutagen sync.

**Architecture:** A focused `src/startup-sync.ts` module owns flag selection, archive/upload/extract orchestration, safe command construction, and watcher lifecycle. `index.ts` registers the flags and invokes the module only after sandbox setup. The existing CLI continues to provide the long-lived Mutagen protocol; no CreateOS CLI flag or command changes are made.

**Tech Stack:** TypeScript, Pi extension API, `BorderedLoader`, Node filesystem APIs, existing `createos` CLI, Bun test runner.

## Global Constraints

- Modify only `packages/pi-extension/` plus this repository's README and design/plan docs.
- Do not add or change `createos-cli` flags or commands.
- Host source is `process.cwd()`; target is exactly `/root/workspace`.
- `--sync-once` and `--watch` are mutually exclusive.
- One-time sync is host-to-sandbox only and retains remote-only files.
- Exclude `.git`, `.hg`, and `.svn` from one-time archives.
- Use `shellQuote` for every shell command value.
- Use an operation loader, not a fabricated percentage bar or per-phase status.

---

### Task 1: Add testable startup-sync primitives

**Files:**

- Create: `packages/pi-extension/src/startup-sync.ts`
- Create: `packages/pi-extension/src/startup-sync.test.ts`
- Modify: `packages/pi-extension/package.json`

**Interfaces:**

- Produces `selectStartupSync(syncOnce: boolean, watch: boolean): "once" | "watch" | undefined`.
- Produces `createArchiveArgs(source: string, archive: string): string[]`.
- Produces `createExtractCommand(archive: string, remoteDir: string): string`.
- Produces `DEFAULT_SYNC_REMOTE_DIR = "/root/workspace"`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { createArchiveArgs, createExtractCommand, selectStartupSync } from "./startup-sync.ts";

describe("selectStartupSync", () => {
  test("selects one-time sync", () => expect(selectStartupSync(true, false)).toBe("once"));
  test("selects watcher sync", () => expect(selectStartupSync(false, true)).toBe("watch"));
  test("does nothing without a flag", () =>
    expect(selectStartupSync(false, false)).toBeUndefined());
  test("rejects incompatible flags", () =>
    expect(() => selectStartupSync(true, true)).toThrow("mutually exclusive"));
});

test("archives project files without VCS metadata", () => {
  expect(createArchiveArgs("/host/project", "/tmp/project.tar.gz")).toEqual([
    "-C",
    "/host/project",
    "--exclude=.git",
    "--exclude=.hg",
    "--exclude=.svn",
    "-czf",
    "/tmp/project.tar.gz",
    ".",
  ]);
});

test("quotes archive and destination when extracting", () => {
  expect(createExtractCommand("/tmp/a file.tar.gz", "/root/work space")).toBe(
    "mkdir -p '/root/work space' && tar -xzf '/tmp/a file.tar.gz' -C '/root/work space' && rm -f '/tmp/a file.tar.gz'",
  );
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `cd packages/pi-extension && bun test src/startup-sync.test.ts`

Expected: FAIL because `./startup-sync.ts` does not exist.

- [ ] **Step 3: Implement the smallest primitives**

```ts
export const DEFAULT_SYNC_REMOTE_DIR = "/root/workspace";

export function selectStartupSync(syncOnce: boolean, watch: boolean): "once" | "watch" | undefined {
  if (syncOnce && watch) throw new Error("--sync-once and --watch are mutually exclusive");
  if (syncOnce) return "once";
  return watch ? "watch" : undefined;
}

export function createArchiveArgs(source: string, archive: string): string[] {
  return ["-C", source, "--exclude=.git", "--exclude=.hg", "--exclude=.svn", "-czf", archive, "."];
}

export function createExtractCommand(archive: string, remoteDir: string): string {
  const quotedArchive = shellQuote(archive);
  const quotedRemoteDir = shellQuote(remoteDir);
  return `mkdir -p ${quotedRemoteDir} && tar -xzf ${quotedArchive} -C ${quotedRemoteDir} && rm -f ${quotedArchive}`;
}
```

- [ ] **Step 4: Verify the tests pass**

Run: `cd packages/pi-extension && bun test src/startup-sync.test.ts`

Expected: PASS with five passing tests.

- [ ] **Step 5: Add the package test command**

```json
"scripts": {
  "test": "bun test src/startup-sync.test.ts",
  "typecheck": "tsc --noEmit"
}
```

- [ ] **Step 6: Commit**

```bash
git add packages/pi-extension/src/startup-sync.ts packages/pi-extension/src/startup-sync.test.ts packages/pi-extension/package.json
git commit -m "test(pi): cover startup sync primitives"
```

### Task 2: Execute and clean up startup sync

**Files:**

- Modify: `packages/pi-extension/src/startup-sync.ts`
- Modify: `packages/pi-extension/src/cli.ts`
- Test: `packages/pi-extension/src/startup-sync.test.ts`

**Interfaces:**

- Consumes `selectStartupSync`, `createArchiveArgs`, and `createExtractCommand` from Task 1.
- Produces `syncProjectOnce(pi, sandboxId, hostDir, signal?): Promise<void>`.
- Produces `startProjectWatch(pi, sandboxId, hostDir, signal?): Promise<{ pid: string }>`.
- Produces `stopProjectWatch(pi, pid): Promise<void>`.

- [ ] **Step 1: Extend failing tests for command safety**

```ts
test("rejects an unsafe one-time source directory", async () => {
  await expect(validateLocalSyncSource(process.env.HOME!)).rejects.toThrow("$HOME");
});
```

- [ ] **Step 2: Verify the new test fails**

Run: `cd packages/pi-extension && bun test src/startup-sync.test.ts`

Expected: FAIL because `validateLocalSyncSource` does not exist.

- [ ] **Step 3: Implement validation and transfer orchestration**

- Resolve and stat the host source with `node:fs/promises`.
- Reject `/`, `$HOME`, and paths under `.ssh`, `.gnupg`, `.aws`, `.config`, `.docker`, `.kube`, `.gcloud`, `.azure`.
- Create a `mkdtemp` archive directory; package with `pi.exec("tar", createArchiveArgs(...), { signal })`.
- Upload the archive using a new CLI wrapper that passes argument arrays to `createos sandbox push`.
- Extract with `sandboxExec`; throw on a non-zero remote exit status.
- Remove local and remote temporary archives in `finally` blocks.
- Change `startSync` to spawn the watcher as a **detached Node child**
  (`spawn("createos", args, { detached: true, stdio: "ignore" })` then
  `child.unref()`), return the numeric PID, and add `stopSync` which kills the
  whole process group (`process.kill(-pid, "SIGTERM")`). Do NOT use
  `nohup ... & echo $!` through `pi.exec` — Pi's `exec` allocates a PTY and the
  backgrounded process dies before Mutagen establishes the session.

- [ ] **Step 4: Verify tests pass**

Run: `cd packages/pi-extension && bun test src/startup-sync.test.ts`

Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd packages/pi-extension && npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/pi-extension/src/startup-sync.ts packages/pi-extension/src/cli.ts packages/pi-extension/src/startup-sync.test.ts
git commit -m "feat(pi): add startup project sync"
```

### Task 3: Wire flags, lifecycle, and TUI status

**Files:**

- Modify: `packages/pi-extension/index.ts`
- Modify: `packages/pi-extension/src/startup-sync.ts`
- Test: `packages/pi-extension/src/startup-sync.test.ts`

**Interfaces:**

- Consumes `syncProjectOnce`, `startProjectWatch`, `stopProjectWatch`, `selectStartupSync`, and `DEFAULT_SYNC_REMOTE_DIR`.
- Produces session startup behaviour for `--sync-once` and `--watch`.

- [ ] **Step 1: Add failing tests for flag selection**

Keep the mutually-exclusive and individual selection tests from Task 1. Add a test for error text that names both flags.

- [ ] **Step 2: Verify tests fail before changing production flag handling**

Run: `cd packages/pi-extension && bun test src/startup-sync.test.ts`

Expected: FAIL until the exact error text is implemented.

- [ ] **Step 3: Register and run the flags**

```ts
pi.registerFlag("sync-once", {
  description: "Copy the host project to /root/workspace before starting Pi",
  type: "boolean",
});
pi.registerFlag("watch", {
  description: "Keep the host project and /root/workspace synchronized",
  type: "boolean",
});
```

After `active` is set in `session_start`, select the mode. For a TUI session, run the setup inside `ctx.ui.custom()` with a `BorderedLoader` whose static message names the overall operation. In non-TUI modes, execute the same operation without custom UI. Set a footer status after `--watch` starts. On `session_shutdown`, stop the watcher PID before `cleanupTempKey` and sandbox destruction.

- [ ] **Step 4: Verify tests pass**

Run: `cd packages/pi-extension && npm test && npm run typecheck`

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-extension/index.ts packages/pi-extension/src/startup-sync.ts packages/pi-extension/src/startup-sync.test.ts
git commit -m "feat(pi): add sync startup flags"
```

### Task 4: Document the extension surface

**Files:**

- Modify: `packages/pi-extension/README.md`
- Modify: `packages/pi-extension/CLAUDE.md`
- Modify: `README.md`

**Interfaces:**

- Documents `pi --createos --sync-once` and `pi --createos --watch`.

- [ ] **Step 1: Add usage documentation**

```md
# Copy the current host project once before Pi begins

pi --createos --sync-once

# Keep the current host project synchronized for the session

pi --createos --watch
```

State that both flags target `/root/workspace`, cannot be combined, and that `--watch` is two-way.

- [ ] **Step 2: Verify documentation references**

Run: `rg -n -- '--sync-once|--watch|/root/workspace' README.md packages/pi-extension/README.md packages/pi-extension/CLAUDE.md`

Expected: all three files describe both flags and the fixed target path.

- [ ] **Step 3: Commit**

```bash
git add README.md packages/pi-extension/README.md packages/pi-extension/CLAUDE.md
git commit -m "docs(pi): document startup sync"
```

### Task 5: Final verification and review

**Files:**

- Verify: `packages/pi-extension/`

- [ ] **Step 1: Run automated checks**

Run: `cd packages/pi-extension && npm test && npm run typecheck`

Expected: exit 0.

- [ ] **Step 2: Run repository formatting and lint checks**

Run: `npm run check`

Expected: exit 0.

- [ ] **Step 3: Inspect the focused diff**

Run: `git diff --check && git diff -- packages/pi-extension README.md docs/superpowers`

Expected: no whitespace errors; only startup-sync implementation, docs, and plans change.

- [ ] **Step 4: Request independent code review**

Review all changes against this plan, focusing on shell quoting, watcher cleanup order, error propagation, and whether the UI claims only observable progress.

- [ ] **Step 5: Commit design and plan documentation**

```bash
git add docs/superpowers/specs/2026-08-11-pi-startup-sync-design.md docs/superpowers/plans/2026-08-11-pi-startup-sync.md
git commit -m "docs(pi): plan startup sync"
```

## Plan self-review

- Spec coverage: Tasks 1–3 cover extension flags, fixed target, one-way archive transfer, existing Mutagen watcher, mutual exclusion, cleanup, and UI. Task 4 covers required user and maintainer documentation. Task 5 covers validation and review.
- Placeholder scan: no TBD, TODO, unspecified test, or unspecified error-handling instruction remains.
- Type consistency: all orchestration names declared in Task 2 are the names consumed in Task 3.
