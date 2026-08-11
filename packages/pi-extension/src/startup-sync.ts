import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  cleanupKey,
  createTempKey,
  pushLocalFile,
  sandboxExec,
  startSync,
  stopSync,
} from "./cli.ts";
import { shellQuote } from "./util.ts";

export const DEFAULT_SYNC_REMOTE_DIR = "/root/workspace";

export interface ProjectWatch {
  pid: string;
  keyPath: string;
}

const VCS_DIRECTORIES = [".git", ".hg", ".svn"];
const SENSITIVE_HOME_DIRECTORIES = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".config",
  ".docker",
  ".kube",
  ".gcloud",
  ".azure",
]);
export function selectStartupSync(syncOnce: boolean, watch: boolean): "once" | "watch" | undefined {
  if (syncOnce && watch) throw new Error("--sync-once and --watch are mutually exclusive");
  if (syncOnce) return "once";
  return watch ? "watch" : undefined;
}

export function createArchiveArgs(source: string, archive: string): string[] {
  return [
    "-C",
    source,
    ...VCS_DIRECTORIES.map((directory) => `--exclude=${directory}`),
    "-czf",
    archive,
    ".",
  ];
}

export async function validateLocalSyncSource(source: string): Promise<string> {
  const resolved = await realpath(source);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`${resolved} is not a directory`);
  if (resolved === sep) throw new Error("refusing to sync from /");

  const home = homedir();
  if (resolved === home) throw new Error("refusing to sync from $HOME itself");
  if (isSensitiveHomePath(resolved, home)) {
    throw new Error(`refusing to sync from sensitive directory ${resolved}`);
  }
  return resolved;
}

export function createExtractCommand(archive: string, remoteDir: string): string {
  const quotedArchive = shellQuote(archive);
  const quotedRemoteDir = shellQuote(remoteDir);
  return `mkdir -p ${quotedRemoteDir} && tar -xzf ${quotedArchive} -C ${quotedRemoteDir} && rm -f ${quotedArchive}`;
}

export async function syncProjectOnce(
  pi: ExtensionAPI,
  sandboxId: string,
  hostDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const source = await validateLocalSyncSource(hostDir);
  const tempDir = await mkdtemp(join(tmpdir(), "pi-createos-sync-"));
  const archive = join(tempDir, "project.tar.gz");
  const remoteArchive = `/tmp/pi-createos-${randomUUID()}.tar.gz`;

  try {
    await createArchive(pi, source, archive, signal);
    await pushLocalFile(pi, sandboxId, archive, remoteArchive, signal);
    await extractArchive(pi, sandboxId, remoteArchive, signal);
  } finally {
    await removeRemoteArchive(pi, sandboxId, remoteArchive);
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function startProjectWatch(
  pi: ExtensionAPI,
  sandboxId: string,
  hostDir: string,
  signal?: AbortSignal,
): Promise<ProjectWatch> {
  const source = await validateLocalSyncSource(hostDir);
  const keyPath = await createTempKey(pi);
  try {
    const { pid } = await startSync(pi, sandboxId, source, DEFAULT_SYNC_REMOTE_DIR, {
      keyPath,
      signal,
    });
    return { pid, keyPath };
  } catch (error) {
    await cleanupKey(pi, keyPath);
    throw error;
  }
}

export async function stopProjectWatch(pi: ExtensionAPI, watch: ProjectWatch): Promise<void> {
  try {
    await stopSync(pi, watch.pid);
  } finally {
    await cleanupKey(pi, watch.keyPath);
  }
}

function isSensitiveHomePath(path: string, home: string): boolean {
  if (!path.startsWith(`${home}${sep}`)) return false;
  const firstSegment = relative(home, path).split(sep)[0];
  return firstSegment !== undefined && SENSITIVE_HOME_DIRECTORIES.has(firstSegment);
}

async function createArchive(
  pi: ExtensionAPI,
  source: string,
  archive: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await pi.exec("tar", createArchiveArgs(source, archive), { signal });
  if (result.code !== 0) throw new Error(`Could not package project: ${commandError(result)}`);
}

async function extractArchive(
  pi: ExtensionAPI,
  sandboxId: string,
  archive: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("Sync cancelled");
  const result = await sandboxExec(
    pi,
    sandboxId,
    createExtractCommand(archive, DEFAULT_SYNC_REMOTE_DIR),
  );
  if (result.exitCode !== 0) throw new Error(`Could not extract project: ${result.stdout.trim()}`);
}

async function removeRemoteArchive(
  pi: ExtensionAPI,
  sandboxId: string,
  archive: string,
): Promise<void> {
  try {
    await sandboxExec(pi, sandboxId, `rm -f ${shellQuote(archive)}`);
  } catch {
    // The original sync error is more useful than cleanup failure.
  }
}

function commandError(result: { stdout?: string; stderr?: string }): string {
  return result.stderr?.trim() || result.stdout?.trim() || "command failed";
}
