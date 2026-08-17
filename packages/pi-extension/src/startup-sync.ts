import { mkdtemp, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export interface ProjectSyncOptions {
  avoidGitIgnore?: boolean;
}

export interface SkillDirectory {
  baseDir: string;
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
  if (syncOnce && watch) {
    throw new Error("--createos-sync-once and --createos-watch are mutually exclusive");
  }
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

export function createSkillArchiveArgs(directories: string[], archive: string): string[] {
  return [
    "-C",
    sep,
    ...VCS_DIRECTORIES.map((directory) => `--exclude=${directory}`),
    "-czf",
    archive,
    ...directories.map((directory) => relative(sep, directory)),
  ];
}

export async function validateLocalSyncSource(source: string): Promise<string> {
  const resolved = await validateDirectory(source);
  if (pathsOverlap(resolved, await resolveAgentDir())) {
    throw new Error("refusing to sync the Pi agent directory");
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
  options: ProjectSyncOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  const source = await validateLocalSyncSource(hostDir);
  const tempDir = await mkdtemp(join(tmpdir(), "pi-createos-sync-"));
  const archive = join(tempDir, "project.tar.gz");
  const fileList = join(tempDir, "files");
  const remoteArchive = `/tmp/pi-createos-${randomUUID()}.tar.gz`;

  try {
    await createProjectArchive(pi, source, archive, fileList, options, signal);
    await pushLocalFile(pi, sandboxId, archive, remoteArchive, signal);
    await extractArchive(pi, sandboxId, remoteArchive, DEFAULT_SYNC_REMOTE_DIR, signal);
  } finally {
    await removeRemoteArchive(pi, sandboxId, remoteArchive);
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function syncSkillDirectories(
  pi: ExtensionAPI,
  sandboxId: string,
  skills: readonly SkillDirectory[],
  signal?: AbortSignal,
): Promise<void> {
  const directories = await resolveSkillDirectories(skills);
  if (directories.length === 0) return;

  const tempDir = await mkdtemp(join(tmpdir(), "pi-createos-skills-"));
  const archive = join(tempDir, "skills.tar.gz");
  const remoteArchive = `/tmp/pi-createos-${randomUUID()}.tar.gz`;

  try {
    await createSkillsArchive(pi, directories, archive, signal);
    await pushLocalFile(pi, sandboxId, archive, remoteArchive, signal);
    await extractArchive(pi, sandboxId, remoteArchive, sep, signal);
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

async function validateDirectory(source: string): Promise<string> {
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

function isSensitiveHomePath(path: string, home: string): boolean {
  if (!path.startsWith(`${home}${sep}`)) return false;
  const firstSegment = relative(home, path).split(sep)[0];
  return firstSegment !== undefined && SENSITIVE_HOME_DIRECTORIES.has(firstSegment);
}

async function resolveAgentDir(): Promise<string> {
  try {
    return await realpath(getAgentDir());
  } catch {
    return getAgentDir();
  }
}

function isWithin(path: string, parent: string): boolean {
  const pathFromParent = relative(parent, path);
  return (
    pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..")
  );
}

function pathsOverlap(first: string, second: string): boolean {
  return isWithin(first, second) || isWithin(second, first);
}

async function validateSkillDirectory(source: string): Promise<string> {
  const resolved = await validateDirectory(source);
  const agentDir = await resolveAgentDir();
  if (!pathsOverlap(resolved, agentDir)) return resolved;

  const segments = relative(agentDir, resolved).split(sep);
  if (
    !isWithin(resolved, agentDir) ||
    !segments.includes("skills") ||
    segments.includes("sessions")
  ) {
    throw new Error("refusing to sync an unsafe Pi skill directory");
  }
  return resolved;
}

async function resolveSkillDirectories(skills: readonly SkillDirectory[]): Promise<string[]> {
  const paths = new Set(skills.map(({ baseDir }) => baseDir));
  for (const directory of paths) {
    if (!isAbsolute(directory)) throw new Error(`skill directory must be absolute: ${directory}`);
    const target = await skillLinkTarget(directory);
    if (target) paths.add(target);
  }

  const directories = [...paths];
  await Promise.all(directories.map(validateSkillDirectory));
  return directories;
}

async function skillLinkTarget(directory: string): Promise<string | undefined> {
  try {
    const target = await readlink(directory);
    return isAbsolute(target) ? target : resolve(dirname(directory), target);
  } catch {
    return undefined;
  }
}

async function createProjectArchive(
  pi: ExtensionAPI,
  source: string,
  archive: string,
  fileList: string,
  options: ProjectSyncOptions,
  signal?: AbortSignal,
): Promise<void> {
  const args =
    !options.avoidGitIgnore && (await isGitRepository(pi, source, signal))
      ? await createGitIgnoreArchiveArgs(pi, source, archive, fileList, signal)
      : createArchiveArgs(source, archive);
  const result = await pi.exec("tar", args, { signal });
  if (result.code !== 0) throw new Error(`Could not package project: ${commandError(result)}`);
}

async function isGitRepository(
  pi: ExtensionAPI,
  source: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await pi.exec("git", ["-C", source, "rev-parse", "--is-inside-work-tree"], {
    signal,
  });
  return result.code === 0 && result.stdout.trim() === "true";
}

async function createGitIgnoreArchiveArgs(
  pi: ExtensionAPI,
  source: string,
  archive: string,
  fileList: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const result = await pi.exec(
    "git",
    ["-C", source, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { signal },
  );
  if (result.code !== 0) throw new Error(`Could not list project files: ${commandError(result)}`);
  await writeFile(fileList, result.stdout);
  return [
    "-C",
    source,
    ...VCS_DIRECTORIES.map((directory) => `--exclude=${directory}`),
    "--null",
    "-T",
    fileList,
    "-czf",
    archive,
  ];
}

async function createSkillsArchive(
  pi: ExtensionAPI,
  directories: string[],
  archive: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await pi.exec("tar", createSkillArchiveArgs(directories, archive), { signal });
  if (result.code !== 0) throw new Error(`Could not package skills: ${commandError(result)}`);
}

async function extractArchive(
  pi: ExtensionAPI,
  sandboxId: string,
  archive: string,
  remoteDir: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("Sync cancelled");
  const result = await sandboxExec(pi, sandboxId, createExtractCommand(archive, remoteDir));
  if (result.exitCode !== 0) throw new Error(`Could not extract archive: ${result.stdout.trim()}`);
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
