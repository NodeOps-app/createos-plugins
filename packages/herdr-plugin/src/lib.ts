import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CREATEOS = process.env.CREATEOS_BIN || "createos";
export const HERDR = process.env.HERDR_BIN_PATH || "herdr";

export type Ctx = {
  workspace_cwd?: string;
  worktree?: { repo_name: string; repo_root: string; checkout_path: string };
  focused_pane_id?: string;
  focused_pane_cwd?: string;
};

export type Entry = {
  box: string;
  boxId: string;
  agent: string;
  bin: string;
  processId: string;
  local: string;
  remote: string;
  deleteArmedAt?: number;
};

export type Config = {
  agent?: string;
  shape?: string;
  rootfs?: string;
  autoPause?: string;
  remoteRoot?: string;
  egress?: string[];
  excludes?: string[];
  syncExcludes?: string[];
};

export class Fail extends Error {}

export function ctx(): Ctx {
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  return raw ? (JSON.parse(raw) as Ctx) : {};
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; inherit?: boolean; env?: Record<string, string> } = {},
): string {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: opts.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });
  if (r.error) throw new Fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || "").toString().trim().split("\n").slice(-8).join("\n");
    throw new Fail(`${cmd} ${args.slice(0, 3).join(" ")} failed (exit ${r.status})\n${detail}`);
  }
  return (r.stdout ?? "").toString();
}

export function cos(args: string[], inherit = false): string {
  return run(CREATEOS, args, { inherit });
}

export function cosJson<T>(args: string[]): T {
  return JSON.parse(cos(["-o", "json", ...args])) as T;
}

/**
 * Run a script in the sandbox login shell with every agent install dir on PATH.
 * Pass any value that came from config or state through `params`, never through
 * string interpolation. They arrive as "$1", "$2", … inside the script.
 */
export function boxExec(
  box: string,
  script: string,
  opts: { stream?: boolean; params?: string[] } = {},
): string {
  // Flags go before the sandbox name. The CLI stops parsing flags at the first
  // positional argument and discards the rest without an error.
  const args = ["sandbox", "exec"];
  if (opts.stream) args.push("--stream");
  args.push(box, "--", "bash", "-lc", script, "herdr-plugin", ...(opts.params ?? []));
  return cos(args, opts.stream ?? false);
}

export function herdr(args: string[]): string {
  return run(HERDR, args);
}

export function herdrJson<T>(args: string[]): T {
  return JSON.parse(herdr(args)) as T;
}

const stateFile = (): string => {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!dir) throw new Fail("HERDR_PLUGIN_STATE_DIR is not set. Run this through Herdr.");
  mkdirSync(dir, { recursive: true });
  return join(dir, "panes.json");
};

/**
 * A corrupt state file is never silently treated as empty. Doing so would let
 * the next write replace every mapping and strand the running sandboxes.
 */
export function readState(): Record<string, Entry> {
  const file = stateFile();
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    return parsed as Record<string, Entry>;
  } catch (error) {
    const backup = `${file}.corrupt-${process.pid}`;
    renameSync(file, backup);
    throw new Fail(
      `State file ${file} is unreadable (${(error as Error).message}). It was moved to ${backup}. Every sandbox it mapped is still running: list them with \`createos sandbox list\`.`,
    );
  }
}

/** Held across read-modify-write, because two panes can start at the same time. */
function withLock<T>(body: () => T): T {
  const lock = `${stateFile()}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (Date.now() > deadline)
        throw new Fail(`Timed out waiting for ${lock}. Remove it if no other action is running.`);
      spawnSync("sleep", ["0.1"]);
    }
  }
  try {
    return body();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* the lock is already gone */
    }
  }
}

export function writeEntry(pane: string, entry: Entry | null): void {
  withLock(() => {
    const all = readState();
    if (entry) all[pane] = entry;
    else delete all[pane];
    const file = stateFile();
    const temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(temp, file);
  });
}

/**
 * A start that has begun but has not yet written its mapping.
 *
 * Provisioning takes about 20 seconds, and the mapping only appears at the end
 * of it. Without this reservation a second key press during that window starts
 * a second provision and bills a second sandbox. It is keyed by the pane the
 * user pressed the key in, because that is what a retry repeats.
 */
export type Pending = { pane?: string; box: string; startedAt: number };

/** A start that never finished must not block the pane for good. */
const PENDING_TTL_MS = 5 * 60_000;

const pendingFile = (): string => join(stateFile(), "..", "pending.json");

function readPending(): Record<string, Pending> {
  const file = pendingFile();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, Pending>;
  } catch {
    // Unlike the mapping, losing this file strands nothing. Reserving again is safe.
    return {};
  }
}

function writePending(all: Record<string, Pending>): void {
  const file = pendingFile();
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`);
  renameSync(temp, file);
}

/**
 * Claims `source` for a start, or returns the reservation already holding it.
 * The check and the claim share one lock, so two presses cannot both win.
 *
 * A reservation covers two panes: the one the key was pressed in, and the one
 * the start opened. `pane split --focus` moves focus onto the new pane, so an
 * impatient second press arrives from there, not from where the first press
 * came. Matching only the source pane would let that retry through.
 */
export function claimPending(source: string, box: string, now: number): Pending | null {
  return withLock(() => {
    const all = readPending();
    for (const [key, held] of Object.entries(all)) {
      if (now - held.startedAt >= PENDING_TTL_MS) continue;
      if (key === source || held.pane === source) return held;
    }
    all[source] = { box, startedAt: now };
    writePending(all);
    return null;
  });
}

/** Records the pane the claim opened, so a retry can name it. */
export function notePendingPane(source: string, pane: string): void {
  withLock(() => {
    const all = readPending();
    const held = all[source];
    if (!held) return;
    held.pane = pane;
    writePending(all);
  });
}

export function releasePending(source: string): void {
  withLock(() => {
    const all = readPending();
    if (!(source in all)) return;
    delete all[source];
    writePending(all);
  });
}

export function config(): Config {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir) return {};
  const file = join(dir, "config.json");
  if (!existsSync(file)) return {};
  const cfg = JSON.parse(readFileSync(file, "utf8")) as Config;
  const known = new Set([
    "agent",
    "shape",
    "rootfs",
    "autoPause",
    "remoteRoot",
    "egress",
    "excludes",
    "syncExcludes",
  ]);
  const unknown = Object.keys(cfg).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new Fail(
      `Unknown config keys: ${unknown.join(", ")}. Supported: ${[...known].join(", ")}`,
    );
  }
  return cfg;
}

/** First stdout line, so an orchestrator can parse the outcome. */
export function result(payload: Record<string, unknown>): void {
  process.stdout.write(
    `CREATEOS_HERDR_RESULT: ${JSON.stringify({ schemaVersion: 1, ...payload })}\n`,
  );
}

export function entryFor(pane: string | undefined): { pane: string; entry: Entry } {
  const id = pane ?? process.env.HERDR_PANE_ID;
  if (!id) throw new Fail("No focused pane. Invoke this action from a pane.");
  const entry = readState()[id];
  if (!entry) throw new Fail(`Pane ${id} is not mapped to a sandbox. Start an agent first.`);
  return { pane: id, entry };
}
