/**
 * Thin wrapper around `createos` CLI commands via `pi.exec()`.
 *
 * Pi's exec may allocate a PTY, so the CLI can think it's interactive.
 * We pass `-o json` explicitly on every command that returns parseable data.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { shellQuote } from "./util.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<ExecResult> {
  const res = await pi.exec("createos", args, { signal });
  return { code: res.code, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function parseJSON<T>(stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON from createos: ${message}`);
  }
}

// --- Sandbox lifecycle ---

export interface SandboxInfo {
  id: string;
  status: string;
  name?: string;
  ip?: string;
  host_id?: string;
  region?: string;
  ingress_url_template?: string;
  [key: string]: unknown;
}

export async function createSandbox(
  pi: ExtensionAPI,
  opts: {
    shape?: string;
    rootfs?: string;
    ingress?: boolean;
    networks?: string[];
    name?: string;
  },
): Promise<SandboxInfo> {
  const args = ["-o", "json", "sandbox", "create", "--shape", opts.shape ?? "s-2vcpu-2gb"];
  if (opts.rootfs) args.push("--rootfs", opts.rootfs);
  if (opts.ingress) args.push("--ingress");
  if (opts.name) args.push("--name", opts.name);
  if (opts.networks) {
    for (const net of opts.networks) args.push("--network", net);
  }
  const res = await run(pi, args);
  if (res.code !== 0) throw new CLIError("sandbox create", res);
  return parseJSON<SandboxInfo>(res.stdout);
}

export async function getSandbox(pi: ExtensionAPI, id: string): Promise<SandboxInfo> {
  const res = await run(pi, ["-o", "json", "sandbox", "get", id]);
  if (res.code !== 0) throw new CLIError("sandbox get", res);
  return parseJSON<SandboxInfo>(res.stdout);
}

export async function destroySandbox(pi: ExtensionAPI, id: string): Promise<void> {
  const res = await run(pi, ["sandbox", "rm", id, "--yes"]);
  if (res.code !== 0) throw new CLIError("sandbox rm", res);
}

export async function pauseSandbox(pi: ExtensionAPI, id: string): Promise<void> {
  const res = await run(pi, ["sandbox", "pause", id]);
  if (res.code !== 0) throw new CLIError("sandbox pause", res);
}

export async function resumeSandbox(pi: ExtensionAPI, id: string): Promise<void> {
  const res = await run(pi, ["sandbox", "resume", id]);
  if (res.code !== 0) throw new CLIError("sandbox resume", res);
}

export async function listSandboxes(pi: ExtensionAPI): Promise<SandboxInfo[]> {
  const res = await run(pi, ["-o", "json", "sandbox", "list"]);
  if (res.code !== 0) throw new CLIError("sandbox list", res);
  const data = parseJSON<SandboxInfo[] | { data: SandboxInfo[] }>(res.stdout);
  return Array.isArray(data) ? data : data.data;
}

export async function forkSandbox(
  pi: ExtensionAPI,
  id: string,
  opts?: { paused?: boolean },
): Promise<SandboxInfo> {
  const args = ["-o", "json", "sandbox", "fork", id];
  if (opts?.paused) args.push("--paused");
  const res = await run(pi, args);
  if (res.code !== 0) throw new CLIError("sandbox fork", res);
  return parseJSON<SandboxInfo>(res.stdout);
}

export async function editSandbox(
  pi: ExtensionAPI,
  id: string,
  opts: { ingress?: boolean; egress?: string[] },
): Promise<void> {
  const args = ["sandbox", "edit", id];
  if (opts.ingress === true) args.push("--ingress", "on");
  if (opts.ingress === false) args.push("--ingress", "off");
  if (opts.egress) {
    for (const rule of opts.egress) args.push("--egress", rule);
  }
  const res = await run(pi, args);
  if (res.code !== 0) throw new CLIError("sandbox edit", res);
}

export async function listShapes(pi: ExtensionAPI): Promise<unknown[]> {
  const res = await run(pi, ["-o", "json", "sandbox", "shapes"]);
  if (res.code !== 0) throw new CLIError("sandbox shapes", res);
  const data = parseJSON<unknown[] | { data: unknown[] }>(res.stdout);
  return Array.isArray(data) ? data : data.data;
}

export async function listRootfs(pi: ExtensionAPI): Promise<unknown> {
  const res = await run(pi, ["-o", "json", "sandbox", "rootfs"]);
  if (res.code !== 0) throw new CLIError("sandbox rootfs", res);
  return parseJSON<unknown>(res.stdout);
}

export async function getBandwidth(
  pi: ExtensionAPI,
  id: string,
): Promise<{ quota_bytes: number; used_bytes: number; remaining_bytes: number; capped: boolean }> {
  // bandwidth is part of sandbox get response
  const info = await getSandbox(pi, id);
  return (
    (info as any).bandwidth ?? { quota_bytes: 0, used_bytes: 0, remaining_bytes: 0, capped: false }
  );
}

// --- Tunnel ---

export async function startTunnel(
  pi: ExtensionAPI,
  sandboxId: string,
  remotePort: number,
  localPort?: number,
): Promise<{ localPort: number; pid: string }> {
  const local = localPort ?? remotePort;
  // Run tunnel in background — it's a long-lived process.
  // We start it detached via shell so pi.exec returns immediately.
  const args = [
    "sandbox",
    "tunnel",
    "--remote",
    String(remotePort),
    "--local",
    String(local),
    sandboxId,
  ];
  // Fire and forget — the tunnel runs until the sandbox is destroyed or session ends.
  // We use pi.exec with a very short timeout just to verify it started, but the real
  // process is spawned via nohup in the background.
  const check = await run(pi, ["sandbox", "get", sandboxId]);
  if (check.code !== 0) throw new CLIError("tunnel preflight", check);

  // Spawn the tunnel as a detached background process on the host.
  const shellCmd = `nohup createos ${args.join(" ")} > /dev/null 2>&1 & echo $!`;
  const res = await pi.exec("sh", ["-c", shellCmd]);
  const pid = res.stdout?.trim() ?? "";
  return { localPort: local, pid };
}

// --- Sync ---

let tempKeyPath: string | undefined;

/** Generate an unencrypted SSH key for a CreateOS sync process. */
export async function createTempKey(pi: ExtensionAPI): Promise<string> {
  const res = await pi.exec("sh", [
    "-c",
    'dir=$(mktemp -d) && ssh-keygen -t ed25519 -f "$dir/id_sync" -N "" -q && echo "$dir/id_sync"',
  ]);
  if (res.code !== 0) throw new Error(`Failed to generate temp SSH key: ${res.stderr}`);
  return res.stdout.trim();
}

/** Generate a temporary unencrypted SSH key for tool-initiated sync. */
export async function ensureTempKey(pi: ExtensionAPI): Promise<string> {
  if (!tempKeyPath) tempKeyPath = await createTempKey(pi);
  return tempKeyPath;
}

export async function cleanupKey(pi: ExtensionAPI, keyPath: string): Promise<void> {
  const dir = keyPath.replace(/\/[^/]+$/, "");
  const result = await pi.exec("rm", ["-rf", dir]);
  if (result.code !== 0) throw new Error(`Failed to clean up temp SSH key: ${result.stderr}`);
}

/** Clean up the reusable temp SSH key on shutdown. */
export async function cleanupTempKey(pi: ExtensionAPI): Promise<void> {
  const keyPath = tempKeyPath;
  if (!keyPath) return;
  await cleanupKey(pi, keyPath);
  if (tempKeyPath === keyPath) tempKeyPath = undefined;
}

export async function startSync(
  pi: ExtensionAPI,
  sandboxId: string,
  localDir: string,
  remoteDir: string,
  opts?: { mode?: string; exclude?: string[]; keyPath?: string; signal?: AbortSignal },
): Promise<{ pid: string }> {
  const check = await run(pi, ["sandbox", "get", sandboxId], opts?.signal);
  if (check.code !== 0) throw new CLIError("sync preflight", check);

  const keyPath = opts?.keyPath ?? (await ensureTempKey(pi));

  const args = [
    "sandbox",
    "sync",
    "--local",
    localDir,
    "--remote",
    remoteDir,
    "--yes",
    "-i",
    keyPath,
  ];
  if (opts?.mode) args.push("--mode", opts.mode);
  if (opts?.exclude) {
    for (const ex of opts.exclude) args.push("--exclude", ex);
  }
  args.push(sandboxId);

  const pid = await startDetached(pi, args, opts?.signal);
  return { pid };
}

export async function stopSync(pi: ExtensionAPI, pid: string): Promise<void> {
  if (!/^\d+$/.test(pid)) throw new Error(`Invalid sync process ID: ${pid}`);
  const result = await pi.exec("kill", ["-TERM", pid]);
  if (result.code !== 0) throw new Error(`Could not stop sync process ${pid}`);
}

async function startDetached(
  pi: ExtensionAPI,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const command = `nohup ${["createos", ...args].map(shellQuote).join(" ")} > /dev/null 2>&1 < /dev/null & echo $!`;
  const result = await pi.exec("sh", ["-c", command], { signal });
  const pid = result.stdout?.trim() ?? "";
  if (result.code !== 0 || !/^\d+$/.test(pid)) throw new Error("Could not start sync process");
  return pid;
}

// --- Exec ---

export async function sandboxExec(
  pi: ExtensionAPI,
  id: string,
  command: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; exitCode: number }> {
  const res = await run(pi, ["sandbox", "exec", id, "--", "sh", "-c", command], signal);
  // CLI preserves the inner command's exit code.
  return { stdout: res.stdout, exitCode: res.code };
}

// --- Files ---

export async function pullFile(pi: ExtensionAPI, id: string, remotePath: string): Promise<string> {
  const res = await run(pi, ["sandbox", "pull", id, remotePath, "-"]);
  if (res.code !== 0) throw new CLIError("sandbox pull", res);
  return res.stdout;
}

export async function pushLocalFile(
  pi: ExtensionAPI,
  id: string,
  localPath: string,
  remotePath: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await run(pi, ["sandbox", "push", id, localPath, remotePath], signal);
  if (res.code !== 0) throw new CLIError("sandbox push", res);
}

export async function pushFile(
  pi: ExtensionAPI,
  id: string,
  content: string,
  remotePath: string,
): Promise<void> {
  // Write content to a temp file on host, then push it.
  // Using exec with base64 is more portable than trying to pipe stdin.
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const res = await run(pi, [
    "sandbox",
    "exec",
    id,
    "--",
    "sh",
    "-c",
    `echo '${b64}' | base64 -d > '${remotePath.replace(/'/g, `'\\''`)}'`,
  ]);
  if (res.code !== 0) throw new CLIError("file write", res);
}

// --- Networks ---

export interface NetworkInfo {
  id: string;
  name: string;
  member_count?: number;
  members?: { sandbox_id: string; status: string; ip: string; name?: string }[];
  [key: string]: unknown;
}

export async function createNetwork(pi: ExtensionAPI, name: string): Promise<NetworkInfo> {
  const res = await run(pi, ["-o", "json", "sandbox", "network", "create", name]);
  if (res.code !== 0) throw new CLIError("network create", res);
  return parseJSON<NetworkInfo>(res.stdout);
}

export async function listNetworks(pi: ExtensionAPI): Promise<NetworkInfo[]> {
  const res = await run(pi, ["-o", "json", "sandbox", "network", "ls"]);
  if (res.code !== 0) throw new CLIError("network ls", res);
  const data = parseJSON<NetworkInfo[] | { data: NetworkInfo[] }>(res.stdout);
  return Array.isArray(data) ? data : data.data;
}

export async function getNetwork(pi: ExtensionAPI, idOrName: string): Promise<NetworkInfo> {
  const res = await run(pi, ["-o", "json", "sandbox", "network", "show", idOrName]);
  if (res.code !== 0) throw new CLIError("network show", res);
  return parseJSON<NetworkInfo>(res.stdout);
}

export async function deleteNetwork(pi: ExtensionAPI, idOrName: string): Promise<void> {
  const res = await run(pi, ["sandbox", "network", "rm", idOrName, "--yes"]);
  if (res.code !== 0) throw new CLIError("network rm", res);
}

export async function attachNetwork(
  pi: ExtensionAPI,
  sandboxId: string,
  netIdOrName: string,
): Promise<void> {
  const res = await run(pi, ["sandbox", "network", "attach", netIdOrName, sandboxId]);
  if (res.code !== 0) throw new CLIError("network attach", res);
}

export async function detachNetwork(
  pi: ExtensionAPI,
  sandboxId: string,
  netIdOrName: string,
): Promise<void> {
  const res = await run(pi, ["sandbox", "network", "detach", netIdOrName, sandboxId, "--yes"]);
  if (res.code !== 0) throw new CLIError("network detach", res);
}

// --- Disks ---

export interface DiskInfo {
  id: string;
  name: string;
  kind?: string;
  config?: { bucket?: string; endpoint?: string; region?: string };
  [key: string]: unknown;
}

export async function createDisk(
  pi: ExtensionAPI,
  opts: {
    name: string;
    bucket: string;
    endpoint: string;
    accessKey: string;
    secretKey: string;
    region?: string;
    pathStyle?: boolean;
  },
): Promise<DiskInfo> {
  const args = [
    "-o",
    "json",
    "sandbox",
    "disk",
    "create",
    opts.name,
    "--bucket",
    opts.bucket,
    "--endpoint",
    opts.endpoint,
    "--access-key",
    opts.accessKey,
    "--secret-key",
    opts.secretKey,
  ];
  if (opts.region) args.push("--region", opts.region);
  if (opts.pathStyle) args.push("--path-style");
  const res = await run(pi, args);
  if (res.code !== 0) throw new CLIError("disk create", res);
  return parseJSON<DiskInfo>(res.stdout);
}

export async function listDisks(pi: ExtensionAPI): Promise<DiskInfo[]> {
  const res = await run(pi, ["-o", "json", "sandbox", "disk", "ls"]);
  if (res.code !== 0) throw new CLIError("disk ls", res);
  const data = parseJSON<DiskInfo[] | { data: DiskInfo[] }>(res.stdout);
  return Array.isArray(data) ? data : data.data;
}

export async function getDisk(pi: ExtensionAPI, idOrName: string): Promise<DiskInfo> {
  const res = await run(pi, ["-o", "json", "sandbox", "disk", "show", idOrName]);
  if (res.code !== 0) throw new CLIError("disk show", res);
  return parseJSON<DiskInfo>(res.stdout);
}

export async function deleteDisk(pi: ExtensionAPI, idOrName: string): Promise<void> {
  const res = await run(pi, ["sandbox", "disk", "rm", idOrName, "--yes"]);
  if (res.code !== 0) throw new CLIError("disk rm", res);
}

export async function attachDisk(
  pi: ExtensionAPI,
  sandboxId: string,
  diskIdOrName: string,
  mountPath: string,
): Promise<void> {
  const res = await run(pi, ["sandbox", "disk", "attach", sandboxId, diskIdOrName, mountPath]);
  if (res.code !== 0) throw new CLIError("disk attach", res);
}

export async function detachDisk(
  pi: ExtensionAPI,
  sandboxId: string,
  diskIdOrName: string,
  mountPath: string,
): Promise<void> {
  const res = await run(pi, [
    "sandbox",
    "disk",
    "detach",
    sandboxId,
    diskIdOrName,
    mountPath,
    "--yes",
  ]);
  if (res.code !== 0) throw new CLIError("disk detach", res);
}

// --- Devices ---

export interface DeviceInfo {
  device_id?: string;
  id?: string;
  name: string;
  client_ip?: string;
  [key: string]: unknown;
}

export async function listDevices(pi: ExtensionAPI): Promise<DeviceInfo[]> {
  const res = await run(pi, ["-o", "json", "sandbox", "devices", "ls"]);
  if (res.code !== 0) throw new CLIError("devices ls", res);
  try {
    const data = parseJSON<DeviceInfo[] | { data: DeviceInfo[] }>(res.stdout);
    return Array.isArray(data) ? data : data.data;
  } catch {
    return [];
  }
}

export async function attachDeviceToNetwork(
  pi: ExtensionAPI,
  deviceId: string,
  netIdOrName: string,
): Promise<void> {
  const res = await run(pi, ["sandbox", "network", "attach", netIdOrName, deviceId]);
  if (res.code !== 0) throw new CLIError("device network attach", res);
}

export async function detachDeviceFromNetwork(
  pi: ExtensionAPI,
  deviceId: string,
  netIdOrName: string,
): Promise<void> {
  const res = await run(pi, ["sandbox", "network", "detach", netIdOrName, deviceId, "--yes"]);
  if (res.code !== 0) throw new CLIError("device network detach", res);
}

export async function registerDevice(pi: ExtensionAPI, name?: string): Promise<string> {
  const args = ["sandbox", "devices", "register"];
  if (name) args.push("--name", name);
  const res = await run(pi, args);
  if (res.code !== 0) throw new CLIError("devices register", res);
  return res.stdout;
}

// --- Helpers ---

const CLI_INSTALL_URL =
  "https://raw.githubusercontent.com/NodeOps-app/createos-cli/main/install.sh";

export async function isCreateOSInstalled(pi: ExtensionAPI): Promise<boolean> {
  try {
    const res = await pi.exec("createos", ["version"]);
    return res.code === 0;
  } catch {
    return false;
  }
}

export async function autoInstallCLI(pi: ExtensionAPI): Promise<boolean> {
  try {
    const res = await pi.exec("bash", ["-c", `curl -sfL "${CLI_INSTALL_URL}" | sh -`]);
    if (res.code !== 0) return false;
    // Verify it landed on PATH
    return isCreateOSInstalled(pi);
  } catch {
    return false;
  }
}

export async function isLoggedIn(pi: ExtensionAPI): Promise<boolean> {
  try {
    const res = await pi.exec("createos", ["-o", "json", "sandbox", "shapes"]);
    return res.code === 0;
  } catch {
    return false;
  }
}

export class CLIError extends Error {
  constructor(
    public readonly command: string,
    public readonly result: ExecResult,
  ) {
    const msg = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    super(`createos ${command}: ${msg}`);
    this.name = "CLIError";
  }

  get isNotFound(): boolean {
    return this.result.stderr.includes("not found") || this.result.code === 404;
  }
}
