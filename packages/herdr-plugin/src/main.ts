#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AGENTS, REMOTE_PATH } from "./agents.ts";
import {
  boxExec,
  claimPending,
  config,
  cos,
  cosJson,
  CREATEOS,
  ctx,
  entryFor,
  Fail,
  herdr,
  notePendingPane,
  releasePending,
  result,
  run,
  writeEntry,
  type Config,
  type Entry,
} from "./lib.ts";

const DEFAULT_REMOTE = "/workspace";
const PATCH = "/tmp/herdr-createos.patch";

/**
 * Herdr runs a pane command as a bare argv with no shell expansion, so the pane
 * needs the same absolute entry point that build.sh writes for the manifest.
 */
const RUN_SH = join(dirname(fileURLToPath(import.meta.url)), "..", "run.sh");

/** Never upload these, even when Git tracks them. */
const DENY = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\//,
  /(^|\/)\.gnupg\//,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.envrc$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.kube\//,
  /(^|\/)\.config\/gcloud\//,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/,
  /(^|\/)credentials(\.json)?$/,
  /(^|\/)\.terraform\//,
  /\.tfstate(\.backup)?$/,
];
const ALLOW = [/(^|\/)\.env\.(example|sample|template)$/];

/** The user's own excludes are checked first, so ALLOW cannot override them. */
export function excluded(path: string, extra: string[]): boolean {
  const userExcluded = extra.some((pattern) =>
    pattern.startsWith("*.")
      ? path.endsWith(pattern.slice(1))
      : pattern.endsWith("/")
        ? path.startsWith(pattern)
        : path === pattern,
  );
  if (userExcluded) return true;
  if (ALLOW.some((re) => re.test(path))) return false;
  return DENY.some((re) => re.test(path));
}

/**
 * The remote root reaches shell scripts and `--cwd`, so it is validated even
 * though it is passed as a positional argument rather than interpolated.
 */
function remoteRoot(cfg: Config): string {
  const path = cfg.remoteRoot ?? DEFAULT_REMOTE;
  if (!/^\/[A-Za-z0-9._/-]*$/.test(path) || path.includes("..")) {
    throw new Fail(
      `remoteRoot must be an absolute path made of letters, digits, dot, underscore, dash, and slash. Got: ${path}`,
    );
  }
  return path;
}

function gitRoot(start: string | undefined): string {
  if (!start)
    throw new Fail("No worktree in the invocation context. Focus a pane inside a repository.");
  return run("git", ["-C", start, "rev-parse", "--show-toplevel"]).trim();
}

/** CreateOS caps sandbox names at 22 characters, so 3 + 12 + 1 + 6 is the budget. */
function boxName(root: string): string {
  const repo = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 12);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `hd-${repo || "repo"}-${suffix}`;
}

/**
 * Git reports a submodule as one bare directory name, so a deny-list that reads
 * only that name never sees the submodule's own .env, credentials, or .git.
 * Drop every gitlink, and everything under it.
 */
export function submodulePrefixes(local: string): string[] {
  const staged = run("git", ["-C", local, "ls-files", "-z", "--stage"]);
  return staged
    .split("\0")
    .filter((line) => line.startsWith("160000 "))
    .map((line) => line.slice(line.indexOf("\t") + 1))
    .filter(Boolean);
}

/**
 * `git ls-files --cached` lists a tracked file even when .gitignore now matches
 * it, so a credential committed once and ignored later would still upload.
 * `check-ignore --no-index` judges tracked paths by the ignore rules too.
 */
function ignoredPaths(local: string, candidates: string[]): Set<string> {
  const r = spawnSync("git", ["-C", local, "check-ignore", "--no-index", "--stdin", "-z"], {
    input: `${candidates.join("\0")}\0`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // Exit 0 means some paths matched, 1 means none did. Anything else is a real error.
  if (r.status !== 0 && r.status !== 1) {
    throw new Fail(`git check-ignore failed (exit ${r.status})\n${(r.stderr ?? "").trim()}`);
  }
  return new Set((r.stdout ?? "").split("\0").filter(Boolean));
}

function upload(box: string, local: string, cfg: Config): number {
  const listed = run("git", [
    "-C",
    local,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const submodules = submodulePrefixes(local);
  const candidates = listed
    .split("\0")
    .filter(Boolean)
    .filter((p) => !submodules.some((s) => p === s || p.startsWith(`${s}/`)))
    .filter((p) => !excluded(p, cfg.excludes ?? []));
  const ignored = ignoredPaths(local, candidates);
  const files = candidates.filter((p) => !ignored.has(p));
  if (files.length === 0) throw new Fail(`No eligible files to upload from ${local}.`);

  const work = mkdtempSync(join(tmpdir(), "herdr-createos-"));
  const listFile = join(work, "files.list");
  const archive = join(work, "ws.tgz");
  try {
    writeFileSync(listFile, `${files.join("\0")}\0`);
    // Two steps, not a pipeline: a shell pipeline reports only the last command's
    // status, so a failed tar would ship a truncated archive as a success.
    // --no-recursion means no directory entry can ever pull in unlisted files.
    run("tar", ["--null", "--no-recursion", "-T", listFile, "-czf", archive], { cwd: local });
    run(CREATEOS, ["sandbox", "push", box, archive, "/tmp/ws.tgz"]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return files.length;
}

/** The remote path is a config value, so it is a positional argument, never interpolated. */
function prepare(box: string, remote: string): void {
  boxExec(
    box,
    `set -e
mkdir -p "$1"
tar -xzf /tmp/ws.tgz -C "$1"
rm -f /tmp/ws.tgz
cd "$1"
git init -q 2>/dev/null || true
git config user.email herdr@createos.local
git config user.name herdr
git add -A
git commit -qm herdr-baseline || true`,
    { params: [remote] },
  );
}

function install(box: string, agentKey: string): string {
  const agent = AGENTS[agentKey];
  if (!agent)
    throw new Fail(`Unknown agent "${agentKey}". Known: ${Object.keys(AGENTS).join(", ")}`);
  if (agent.install) {
    boxExec(box, `export PATH="${REMOTE_PATH}"\n${agent.install}`, { stream: true });
  }
  const resolved = boxExec(box, `export PATH="${REMOTE_PATH}"; command -v ${agent.bin}`).trim();
  if (!resolved)
    throw new Fail(`${agent.title} installed but ${agent.bin} is not on PATH inside the sandbox.`);
  return resolved.split("\n").pop() as string;
}

// Every flag goes before the sandbox name. The CLI parses flags with urfave/cli,
// which stops at the first positional argument, so a --cwd written after the box
// name is discarded without an error and the agent starts in the home directory
// instead of the uploaded worktree. Fixed CLI-side too, but this order also works
// on already-released CLI versions.
function launch(box: string, bin: string, remote: string): string {
  const started = cosJson<{ process_id: string }>([
    "sandbox",
    "process",
    "start",
    "--pty",
    "--cwd",
    remote,
    "--rows",
    "40",
    "--cols",
    "120",
    box,
    "--",
    bin,
  ]);
  return started.process_id;
}

function paneIdOf(raw: string): string {
  const found = /"pane_id"\s*:\s*"([^"]+)"/.exec(raw);
  if (!found) throw new Fail(`Herdr did not return a pane id:\n${raw.slice(0, 400)}`);
  return found[1] as string;
}

function attachCommand(entry: Entry): string[] {
  return [CREATEOS, "sandbox", "process", "attach", entry.boxId, entry.processId];
}

function boxStatus(box: string): string {
  return cosJson<{ status: string }>(["sandbox", "get", box]).status;
}

function running(entry: Entry): boolean {
  const procs = cosJson<Array<{ process_id: string; state: string }>>([
    "sandbox",
    "process",
    "list",
    entry.boxId,
  ]);
  return procs.some((p) => p.process_id === entry.processId && p.state === "running");
}

/**
 * What `start` hands to `provision`. One argument, so argument order cannot drift.
 *
 * It travels as base64, because `herdr pane run` types its command into the
 * pane's shell without quoting. Raw JSON is word-split there and loses its
 * quotes. Base64 uses only A-Za-z0-9+/= and never starts with `=`, so no shell
 * touches it.
 */
type Spec = {
  /** The pane the key was pressed in. It holds the reservation this must release. */
  source: string;
  pane: string;
  local: string;
  remote: string;
  agent: string;
  name: string;
  cfg: Config;
};

/**
 * The pane is opened before any work begins, and the work then runs inside it.
 * Provisioning takes around 20 seconds, of which the agent installer alone is
 * about half. Doing the work first and opening a finished pane last left the
 * user watching nothing, with no way to tell a slow start from a dead one, so
 * they pressed the key again and paid for a second sandbox.
 */
function start(): void {
  const c = ctx();
  const cfg = config();
  const agentKey = cfg.agent ?? "claude-code";
  const agent = AGENTS[agentKey];
  if (!agent)
    throw new Fail(`Unknown agent "${agentKey}". Known: ${Object.keys(AGENTS).join(", ")}`);
  const local = gitRoot(c.worktree?.checkout_path ?? c.focused_pane_cwd ?? c.workspace_cwd);
  const source = c.focused_pane_id;
  if (!source) throw new Fail("No focused pane to split.");
  const remote = remoteRoot(cfg);
  const name = boxName(local);

  // Same reason as Spec: pane commands reach a shell unquoted. Checked before
  // anything is claimed or created, so a bad path costs nothing.
  if (/[^A-Za-z0-9._/-]/.test(RUN_SH)) {
    throw new Fail(
      `The plugin path contains a character a shell would split on: ${RUN_SH}. Install the plugin under a path made of letters, digits, dot, underscore, dash, and slash.`,
    );
  }

  // Claim the source pane before opening anything. The mapping that would
  // otherwise mark this pane as taken is written about 20 seconds from now, at
  // the end of provisioning, so without this a second key press bills a second
  // sandbox. The claim and its check share one lock.
  const held = claimPending(source, name, Date.now());
  if (held) {
    const seconds = Math.round((Date.now() - held.startedAt) / 1000);
    const where = held.pane ? ` in pane ${held.pane}` : "";
    throw new Fail(
      `${held.box} has been provisioning${where} for ${seconds}s. Watch that pane. To run a second agent from here, wait for it to finish.`,
    );
  }

  let pane: string;
  try {
    const split = ["pane", "split", "--pane", source, "--direction", "right", "--focus"];
    if (agent.detect) split.push("--env", `HERDR_AGENT=${agent.detect}`);
    // provision runs in the pane, not as a Herdr action, so it does not inherit
    // the plugin directories. Hand them over explicitly.
    for (const key of ["HERDR_PLUGIN_STATE_DIR", "HERDR_PLUGIN_CONFIG_DIR"]) {
      const value = process.env[key];
      if (value) split.push("--env", `${key}=${value}`);
    }
    pane = paneIdOf(herdr(split));
    notePendingPane(source, pane);

    const spec: Spec = { source, pane, local, remote, agent: agentKey, name, cfg };
    herdr(["pane", "rename", pane, `${agent.title} starting in ${name}`]);
    const packed = Buffer.from(JSON.stringify(spec), "utf8").toString("base64");
    herdr(["pane", "run", pane, RUN_SH, "provision", packed]);
  } catch (error) {
    // provision never got the claim, so nothing else will ever release it.
    releasePending(source);
    throw error;
  }

  result({ action: "start", ok: true, box: name, pane, agent: agentKey, provisioning: true });
  process.stdout.write(`Provisioning ${name} in pane ${pane}. Watch that pane for progress.\n`);
}

const STEPS = 5;
function step(n: number, message: string): void {
  process.stdout.write(`\n[${n}/${STEPS}] ${message}\n`);
}

/** Runs inside the pane it provisions, so every line below is visible live. */
function provision(): void {
  const packed = process.argv[3];
  if (!packed) throw new Fail("provision needs its spec. Herdr starts this, not you.");
  const spec = JSON.parse(Buffer.from(packed, "base64").toString("utf8")) as Spec;
  // Release on every exit path below, or one failed start blocks the source
  // pane until the reservation expires. The handover to the agent sits outside
  // this block, because process.exit skips finally.
  let entry: Entry;
  try {
    entry = provisionInto(spec);
  } finally {
    releasePending(spec.source);
  }

  // Hand the pane to the agent. This process stays as its parent, so the pane
  // falls back to a shell when the agent exits.
  const [cmd, ...args] = attachCommand(entry);
  const attached = spawnSync(cmd as string, args, { stdio: "inherit" });
  process.exit(attached.status ?? 0);
}

function provisionInto(spec: Spec): Entry {
  const agent = AGENTS[spec.agent];
  if (!agent) throw new Fail(`Unknown agent "${spec.agent}".`);

  step(1, `Creating sandbox ${spec.name} (${spec.cfg.shape ?? "s-2vcpu-4gb"})...`);
  const create = [
    "sandbox",
    "create",
    "--name",
    spec.name,
    "--shape",
    spec.cfg.shape ?? "s-2vcpu-4gb",
  ];
  if (spec.cfg.rootfs) create.push("--rootfs", spec.cfg.rootfs);
  create.push("--auto-pause", spec.cfg.autoPause ?? "30m");
  for (const host of spec.cfg.egress ?? []) create.push("--egress", host);
  const box = cosJson<{ id: string; name: string }>(create);
  process.stdout.write(`      ${box.id}\n`);

  // Everything after creation is billed. A failure here must not strand a
  // sandbox that no mapping records and no action can reach.
  let entry: Entry;
  try {
    step(2, `Uploading the worktree to ${spec.remote}...`);
    const uploaded = upload(box.id, spec.local, spec.cfg);
    process.stdout.write(`      ${uploaded} files\n`);

    step(3, "Preparing the workspace and its baseline commit...");
    prepare(box.id, spec.remote);

    step(4, `Installing ${agent.title}. This is the slow part.`);
    const bin = install(box.id, spec.agent);
    process.stdout.write(`      ${bin}\n`);

    step(5, `Starting ${agent.title} in ${spec.remote}...`);
    const processId = launch(box.id, bin, spec.remote);
    entry = {
      box: spec.name,
      boxId: box.id,
      agent: spec.agent,
      bin,
      processId,
      local: spec.local,
      remote: spec.remote,
    };
    writeEntry(spec.pane, entry);
  } catch (error) {
    let cleanup = `Deleted the sandbox ${spec.name} (${box.id}).`;
    try {
      cos(["sandbox", "rm", "--yes", box.id]);
    } catch {
      cleanup = `The sandbox ${spec.name} (${box.id}) is still running and is not mapped to any pane. Delete it with: createos sandbox rm --yes ${box.id}`;
    }
    throw new Fail(`${(error as Error).message}\n${cleanup}`);
  }

  herdr(["pane", "rename", spec.pane, `${agent.title} @ ${spec.name}`]);
  result({ action: "provision", ok: true, box: spec.name, boxId: box.id, pane: spec.pane });
  return entry;
}

function attach(): void {
  const { pane, entry } = entryFor(ctx().focused_pane_id);
  if (boxStatus(entry.boxId) === "paused") cos(["sandbox", "resume", entry.boxId]);
  if (!running(entry)) {
    entry.processId = launch(entry.boxId, entry.bin, entry.remote);
    writeEntry(pane, entry);
  }
  herdr(["pane", "run", pane, ...attachCommand(entry)]);
  result({ action: "attach", ok: true, box: entry.box, processId: entry.processId });
}

function sync(): void {
  const { pane, entry } = entryFor(ctx().focused_pane_id);
  const cfg = config();
  const split = [
    "pane",
    "split",
    "--pane",
    pane,
    "--direction",
    "down",
    "--ratio",
    "0.25",
    "--no-focus",
  ];
  const target = paneIdOf(herdr(split));
  // Flags first, sandbox name last. See the comment on launch().
  const command = [
    CREATEOS,
    "sandbox",
    "sync",
    "--local",
    entry.local,
    "--remote",
    entry.remote,
    "--mode",
    "two-way",
    "--yes",
  ];
  for (const pattern of cfg.syncExcludes ?? [".git", "node_modules"])
    command.push("--exclude", pattern);
  command.push(entry.boxId);
  herdr(["pane", "rename", target, `sync ${entry.box}`]);
  herdr(["pane", "run", target, ...command]);
  result({ action: "sync", ok: true, box: entry.box, pane: target });
}

function apply(): void {
  const { entry } = entryFor(ctx().focused_pane_id);
  const size = Number(
    boxExec(
      entry.boxId,
      `set -e
cd "$1"
git add -A
git diff --binary --cached HEAD > "$2"
wc -c < "$2"`,
      { params: [entry.remote, PATCH] },
    ).trim(),
  );
  if (size === 0) {
    result({ action: "apply", ok: true, result: "no-changes", box: entry.box });
    process.stdout.write("No changes in the sandbox.\n");
    return;
  }
  const work = mkdtempSync(join(tmpdir(), "herdr-createos-"));
  const localPatch = join(work, "changes.patch");
  try {
    cos(["sandbox", "pull", entry.boxId, PATCH, localPatch]);
    try {
      run("git", ["-C", entry.local, "apply", "--check", localPatch]);
    } catch (error) {
      throw new Fail(
        `Patch does not apply cleanly to ${entry.local}.\n${(error as Error).message}`,
      );
    }
    run("git", ["-C", entry.local, "apply", localPatch]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  // The local worktree is already changed. If the sandbox baseline cannot move
  // forward, say so plainly: the next apply would otherwise export this same
  // patch again and fail its check against files that already carry it.
  try {
    boxExec(entry.boxId, 'cd "$1" && git commit -qm herdr-apply', { params: [entry.remote] });
  } catch (error) {
    throw new Fail(
      `Applied ${size} bytes to ${entry.local}, but the sandbox baseline commit failed, so the sandbox still reports these changes as new.\nRun this in the sandbox before the next apply: createos sandbox exec ${entry.boxId} -- bash -lc 'cd ${entry.remote} && git commit -m herdr-apply'\n${(error as Error).message}`,
    );
  }
  result({ action: "apply", ok: true, result: "applied", box: entry.box, bytes: size });
  process.stdout.write(`Applied ${size} bytes of changes to ${entry.local}.\n`);
}

function pause(): void {
  const { entry } = entryFor(ctx().focused_pane_id);
  cos(["sandbox", "pause", entry.boxId]);
  result({ action: "pause", ok: true, box: entry.box });
}

function resume(): void {
  const { entry } = entryFor(ctx().focused_pane_id);
  cos(["sandbox", "resume", entry.boxId]);
  result({ action: "resume", ok: true, box: entry.box });
}

/** Deletion is irreversible, so the action must be invoked twice within 60 seconds. */
function remove(): void {
  const { pane, entry } = entryFor(ctx().focused_pane_id);
  const now = Date.now();
  if (!entry.deleteArmedAt || now - entry.deleteArmedAt > 60_000) {
    writeEntry(pane, { ...entry, deleteArmedAt: now });
    result({ action: "delete", ok: true, result: "confirmation-required", box: entry.box });
    process.stdout.write(
      `This permanently deletes sandbox ${entry.box}. Invoke the action again within 60 seconds to confirm.\n`,
    );
    return;
  }
  cos(["sandbox", "rm", "--yes", entry.boxId]);
  writeEntry(pane, null);
  result({ action: "delete", ok: true, box: entry.box });
  process.stdout.write(`Deleted ${entry.box} and forgot the mapping for pane ${pane}.\n`);
}

function info(): void {
  const { pane, entry } = entryFor(ctx().focused_pane_id);
  let status = "unknown";
  try {
    status = boxStatus(entry.boxId);
  } catch {
    status = "missing";
  }
  const state = { status };
  result({ action: "info", ok: true, pane, ...entry, status: state.status });
  process.stdout.write(
    `pane ${pane}\n  agent   ${entry.agent} (${entry.bin})\n  sandbox ${entry.box} [${state.status}]\n  local   ${entry.local}\n  remote  ${entry.remote}\n  process ${entry.processId}\n`,
  );
}

function boxes(): never {
  for (;;) {
    process.stdout.write("\u001b[2J\u001b[H");
    try {
      cos(["sandbox", "list"], true);
    } catch (error) {
      process.stdout.write(`${(error as Error).message}\n`);
    }
    run("sleep", ["5"]);
  }
}

const ACTIONS: Record<string, () => void> = {
  start,
  // Not in the manifest. `start` runs this inside the pane it just opened.
  provision,
  attach,
  sync,
  apply,
  pause,
  resume,
  delete: remove,
  info,
  boxes,
};

// Guarded, so the test file can import the filters without running an action.
if (import.meta.main) {
  const name = process.argv[2] ?? process.env.HERDR_PLUGIN_ACTION_ID ?? "";
  const action = ACTIONS[name];
  if (!action) {
    process.stderr.write(`Unknown action "${name}". Known: ${Object.keys(ACTIONS).join(", ")}\n`);
    process.exit(2);
  }
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result({ action: name, ok: false, error: message });
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
