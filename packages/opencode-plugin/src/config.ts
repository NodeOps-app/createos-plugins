import { posix } from "node:path";
import { integer, text } from "./util.ts";

export interface Config {
  mode: "local" | "remote";
  shape: string;
  rootfs: string;
  autoPause: string;
  cwd: string;
  sync: "none" | "once";
  network?: string;
  persist: boolean;
  timeout: number;
  syncSkills: boolean;
}
export function configure(options: Record<string, unknown>, env = process.env): Config {
  const allowed = new Set([
    "mode",
    "shape",
    "rootfs",
    "autoPause",
    "cwd",
    "sync",
    "network",
    "persist",
    "timeout",
    "syncSkills",
  ]);
  for (const key of Object.keys(options))
    if (!allowed.has(key)) throw new Error(`Unknown CreateOS option: ${key}`);
  const mode = env.CREATEOS_MODE ?? options.mode ?? "local";
  const sync = env.CREATEOS_SYNC ?? options.sync ?? "none";
  if (mode !== "local" && mode !== "remote") throw new Error("mode must be local or remote");
  if (sync !== "none" && sync !== "once") throw new Error("sync must be none or once");
  const cwd = text(env.CREATEOS_CWD ?? options.cwd, "cwd", "/root/workspace");
  if (!posix.isAbsolute(cwd)) throw new Error("cwd must be an absolute Linux path");
  const persist =
    env.CREATEOS_PERSIST === undefined
      ? (options.persist ?? true)
      : env.CREATEOS_PERSIST === "true";
  if (env.CREATEOS_PERSIST !== undefined && !["true", "false"].includes(env.CREATEOS_PERSIST))
    throw new Error("CREATEOS_PERSIST must be true or false");
  if (typeof persist !== "boolean") throw new Error("persist must be boolean");
  if (options.syncSkills !== undefined && typeof options.syncSkills !== "boolean")
    throw new Error("syncSkills must be boolean");
  return {
    mode,
    sync,
    cwd: posix.normalize(cwd),
    persist,
    syncSkills: options.syncSkills !== false,
    shape: text(env.CREATEOS_SHAPE ?? options.shape, "shape", "s-2vcpu-2gb"),
    rootfs: text(env.CREATEOS_ROOTFS ?? options.rootfs, "rootfs", "devbox:1"),
    autoPause: text(env.CREATEOS_AUTO_PAUSE ?? options.autoPause, "autoPause", "30m"),
    network:
      env.CREATEOS_NETWORK ??
      (options.network === undefined ? undefined : text(options.network, "network")),
    timeout: integer(
      env.CREATEOS_TIMEOUT ? Number(env.CREATEOS_TIMEOUT) : options.timeout,
      "timeout",
      120_000,
    ),
  };
}
