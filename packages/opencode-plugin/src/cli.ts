/**
 * CLI wrapper for the createos binary.
 *
 * Ported from the Pi extension's cli.ts — every function that previously took
 * `pi: ExtensionAPI` and called `pi.exec('createos', args)` now takes `$: any`
 * (Bun shell) and calls `await $\`sh -c ${cmd}\`.nothrow().quiet()`.
 */

import { shellQuote } from "./util.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

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

export interface NetworkInfo {
  id: string;
  name: string;
  member_count?: number;
  members?: { sandbox_id: string; status: string; ip: string; name?: string }[];
  [key: string]: unknown;
}

export interface DiskInfo {
  id: string;
  name: string;
  kind?: string;
  config?: { bucket?: string; endpoint?: string; region?: string };
  [key: string]: unknown;
}

export interface DeviceInfo {
  device_id?: string;
  id?: string;
  name: string;
  client_ip?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class CLIError extends Error {
  code: number;
  stdout: string;
  stderr: string;

  constructor(command: string, res: ExecResult) {
    const msg = res.stderr.trim() || res.stdout.trim() || `command failed with code ${res.code}`;
    super(`createos ${command}: ${msg}`);
    this.name = "CLIError";
    this.code = res.code;
    this.stdout = res.stdout;
    this.stderr = res.stderr;
  }
}

// ---------------------------------------------------------------------------
// Internal runner
// ---------------------------------------------------------------------------

function execCmd(cmd: string): { code: number; stdout: string; stderr: string } {
  const { execSync } = require("child_process");
  try {
    const stdout = execSync(cmd, {
      encoding: "utf-8",
      timeout: 120000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err: any) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

async function run(_$: any, args: string[]): Promise<ExecResult> {
  // Shell-quote every arg to prevent pipes/redirects/semicolons from breaking out
  const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
  const cmd = ["createos", ...args.map((a) => (a === "--" ? "--" : quote(a)))].join(" ");
  return execCmd(cmd);
}

// ---------------------------------------------------------------------------
// JSON parser
// ---------------------------------------------------------------------------

function parseJSON<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

// ---------------------------------------------------------------------------
// Sandbox operations
// ---------------------------------------------------------------------------

export async function createSandbox(
  $: any,
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
  const res = await run($, args);
  if (res.code !== 0) throw new CLIError("sandbox create", res);
  return parseJSON<SandboxInfo>(res.stdout);
}

export async function getSandbox($: any, id: string): Promise<SandboxInfo> {
  const res = await run($, ["-o", "json", "sandbox", "get", id]);
  if (res.code !== 0) throw new CLIError("sandbox get", res);
  return parseJSON<SandboxInfo>(res.stdout);
}

export async function destroySandbox($: any, id: string): Promise<void> {
  const res = await run($, ["sandbox", "rm", "--yes", id]);
  if (res.code !== 0) throw new CLIError("sandbox rm", res);
}

export async function pauseSandbox($: any, id: string): Promise<void> {
  const res = await run($, ["sandbox", "pause", id]);
  if (res.code !== 0) throw new CLIError("sandbox pause", res);
}

export async function resumeSandbox($: any, id: string): Promise<void> {
  const res = await run($, ["sandbox", "resume", id]);
  if (res.code !== 0) throw new CLIError("sandbox resume", res);
}

export async function listSandboxes($: any): Promise<SandboxInfo[]> {
  const res = await run($, ["-o", "json", "sandbox", "list"]);
  if (res.code !== 0) throw new CLIError("sandbox list", res);
  const parsed = parseJSON<SandboxInfo[] | { data: SandboxInfo[] }>(res.stdout);
  return Array.isArray(parsed) ? parsed : parsed.data;
}

export async function forkSandbox(
  $: any,
  id: string,
  opts?: { paused?: boolean },
): Promise<SandboxInfo> {
  const args = ["-o", "json", "sandbox", "fork", id];
  if (opts?.paused) args.push("--paused");
  const res = await run($, args);
  if (res.code !== 0) throw new CLIError("sandbox fork", res);
  return parseJSON<SandboxInfo>(res.stdout);
}

export async function editSandbox(
  $: any,
  id: string,
  opts: { ingress?: boolean; egress?: string[] },
): Promise<void> {
  const args = ["sandbox", "edit", id];
  if (opts.ingress === true) args.push("--ingress", "on");
  if (opts.ingress === false) args.push("--ingress", "off");
  if (opts.egress) {
    for (const rule of opts.egress) args.push("--egress", rule);
  }
  const res = await run($, args);
  if (res.code !== 0) throw new CLIError("sandbox edit", res);
}

// ---------------------------------------------------------------------------
// Shapes & rootfs
// ---------------------------------------------------------------------------

export async function listShapes($: any): Promise<unknown[]> {
  const res = await run($, ["-o", "json", "sandbox", "shapes"]);
  if (res.code !== 0) throw new CLIError("sandbox shapes", res);
  return parseJSON<unknown[]>(res.stdout);
}

export async function listRootfs($: any): Promise<unknown[]> {
  const res = await run($, ["-o", "json", "sandbox", "rootfs"]);
  if (res.code !== 0) throw new CLIError("sandbox rootfs", res);
  return parseJSON<unknown[]>(res.stdout);
}

// ---------------------------------------------------------------------------
// Bandwidth
// ---------------------------------------------------------------------------

export async function getBandwidth($: any, id: string): Promise<unknown> {
  const info = await getSandbox($, id);
  return (info as any).bandwidth ?? null;
}

// ---------------------------------------------------------------------------
// Tunnel
// ---------------------------------------------------------------------------

export async function startTunnel(
  $: any,
  sandboxId: string,
  remotePort: number,
  localPort?: number,
): Promise<{ localPort: number; pid: string }> {
  const local = localPort ?? remotePort;
  const check = await run($, ["sandbox", "get", sandboxId]);
  if (check.code !== 0) throw new CLIError("tunnel preflight", check);

  const args = [
    "sandbox",
    "tunnel",
    "--remote",
    String(remotePort),
    "--local",
    String(local),
    sandboxId,
  ];
  const shellCmd = `nohup createos ${args.join(" ")} > /dev/null 2>&1 & echo $!`;
  const res = execCmd(shellCmd);
  return { localPort: local, pid: res.stdout.trim() };
}

// ---------------------------------------------------------------------------
// Temp SSH key
// ---------------------------------------------------------------------------

let tempKeyPath: string | undefined;

export async function ensureTempKey(_$: any): Promise<string> {
  if (tempKeyPath) return tempKeyPath;
  const shellCmd =
    'dir=$(mktemp -d) && ssh-keygen -t ed25519 -f "$dir/id_sync" -N "" -q && echo "$dir/id_sync"';
  const res = execCmd(shellCmd);
  if (res.code !== 0) throw new Error(`Failed to generate temp SSH key: ${res.stderr}`);
  tempKeyPath = res.stdout.trim();
  return tempKeyPath;
}

export async function cleanupTempKey(_$: any): Promise<void> {
  if (!tempKeyPath) return;
  const dir = tempKeyPath.replace(/\/[^/]+$/, "");
  execCmd("rm -rf " + shellQuote(dir));
  tempKeyPath = undefined;
}

// ---------------------------------------------------------------------------
// File sync (mutagen)
// ---------------------------------------------------------------------------

export async function startSync(
  $: any,
  sandboxId: string,
  localDir: string,
  remoteDir: string,
  opts?: { mode?: string; exclude?: string[] },
): Promise<{ pid: string }> {
  const check = await run($, ["sandbox", "get", sandboxId]);
  if (check.code !== 0) throw new CLIError("sync preflight", check);

  const keyPath = await ensureTempKey($);

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

  const shellCmd = `nohup createos ${args.join(" ")} > /dev/null 2>&1 & echo $!`;
  const res = execCmd(shellCmd);
  return { pid: res.stdout.trim() };
}

// ---------------------------------------------------------------------------
// Sandbox exec
// ---------------------------------------------------------------------------

export async function sandboxExec($: any, id: string, command: string): Promise<ExecResult> {
  const res = await run($, ["sandbox", "exec", id, "--", "sh", "-c", command]);
  return res;
}

// ---------------------------------------------------------------------------
// File transfer
// ---------------------------------------------------------------------------

export async function pullFile($: any, id: string, remotePath: string): Promise<string> {
  const res = await run($, ["sandbox", "pull", id, remotePath, "-"]);
  if (res.code !== 0) throw new CLIError("sandbox pull", res);
  return res.stdout;
}

export async function pushFile(
  $: any,
  id: string,
  content: string,
  remotePath: string,
): Promise<void> {
  const b64 = Buffer.from(content).toString("base64");
  const cmd = `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(remotePath)}`;
  const res = await sandboxExec($, id, cmd);
  if (res.code !== 0) throw new CLIError("pushFile", res);
}

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

export async function createNetwork($: any, name: string): Promise<NetworkInfo> {
  const res = await run($, ["-o", "json", "sandbox", "network", "create", name]);
  if (res.code !== 0) throw new CLIError("network create", res);
  return parseJSON<NetworkInfo>(res.stdout);
}

export async function listNetworks($: any): Promise<NetworkInfo[]> {
  const res = await run($, ["-o", "json", "sandbox", "network", "ls"]);
  if (res.code !== 0) throw new CLIError("network ls", res);
  const parsed = parseJSON<NetworkInfo[] | { data: NetworkInfo[] }>(res.stdout);
  return Array.isArray(parsed) ? parsed : parsed.data;
}

export async function getNetwork($: any, idOrName: string): Promise<NetworkInfo> {
  const res = await run($, ["-o", "json", "sandbox", "network", "show", idOrName]);
  if (res.code !== 0) throw new CLIError("network show", res);
  return parseJSON<NetworkInfo>(res.stdout);
}

export async function deleteNetwork($: any, idOrName: string): Promise<void> {
  const res = await run($, ["sandbox", "network", "rm", idOrName, "--yes"]);
  if (res.code !== 0) throw new CLIError("network rm", res);
}

export async function attachNetwork($: any, sandboxId: string, netIdOrName: string): Promise<void> {
  const res = await run($, ["sandbox", "network", "attach", sandboxId, netIdOrName]);
  if (res.code !== 0) throw new CLIError("network attach", res);
}

export async function detachNetwork($: any, sandboxId: string, netIdOrName: string): Promise<void> {
  const res = await run($, ["sandbox", "network", "detach", sandboxId, netIdOrName, "--yes"]);
  if (res.code !== 0) throw new CLIError("network detach", res);
}

// ---------------------------------------------------------------------------
// Disks
// ---------------------------------------------------------------------------

export async function createDisk(
  $: any,
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
  const res = await run($, args);
  if (res.code !== 0) throw new CLIError("disk create", res);
  return parseJSON<DiskInfo>(res.stdout);
}

export async function listDisks($: any): Promise<DiskInfo[]> {
  const res = await run($, ["-o", "json", "sandbox", "disk", "ls"]);
  if (res.code !== 0) throw new CLIError("disk ls", res);
  const parsed = parseJSON<DiskInfo[] | { data: DiskInfo[] }>(res.stdout);
  return Array.isArray(parsed) ? parsed : parsed.data;
}

export async function getDisk($: any, idOrName: string): Promise<DiskInfo> {
  const res = await run($, ["-o", "json", "sandbox", "disk", "show", idOrName]);
  if (res.code !== 0) throw new CLIError("disk show", res);
  return parseJSON<DiskInfo>(res.stdout);
}

export async function deleteDisk($: any, idOrName: string): Promise<void> {
  const res = await run($, ["sandbox", "disk", "rm", idOrName, "--yes"]);
  if (res.code !== 0) throw new CLIError("disk rm", res);
}

export async function attachDisk(
  $: any,
  sandboxId: string,
  diskIdOrName: string,
  mountPath: string,
): Promise<void> {
  const res = await run($, ["sandbox", "disk", "attach", sandboxId, diskIdOrName, mountPath]);
  if (res.code !== 0) throw new CLIError("disk attach", res);
}

export async function detachDisk(
  $: any,
  sandboxId: string,
  diskIdOrName: string,
  mountPath: string,
): Promise<void> {
  const res = await run($, [
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

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export async function listDevices($: any): Promise<DeviceInfo[]> {
  const res = await run($, ["-o", "json", "sandbox", "devices", "ls"]);
  if (res.code !== 0) throw new CLIError("devices ls", res);
  const parsed = parseJSON<DeviceInfo[] | { data: DeviceInfo[] }>(res.stdout);
  return Array.isArray(parsed) ? parsed : parsed.data;
}

export async function attachDeviceToNetwork(
  $: any,
  deviceId: string,
  netIdOrName: string,
): Promise<void> {
  const res = await run($, ["sandbox", "network", "attach", deviceId, netIdOrName]);
  if (res.code !== 0) throw new CLIError("network attach (device)", res);
}

export async function detachDeviceFromNetwork(
  $: any,
  deviceId: string,
  netIdOrName: string,
): Promise<void> {
  const res = await run($, ["sandbox", "network", "detach", deviceId, netIdOrName, "--yes"]);
  if (res.code !== 0) throw new CLIError("network detach (device)", res);
}

export async function registerDevice($: any, name?: string): Promise<string> {
  const args = ["sandbox", "devices", "register"];
  if (name) args.push("--name", name);
  const res = await run($, args);
  if (res.code !== 0) throw new CLIError("devices register", res);
  return res.stdout;
}

// ---------------------------------------------------------------------------
// CLI availability & auth
// ---------------------------------------------------------------------------

export async function isCreateOSInstalled($: any): Promise<boolean> {
  const res = await run($, ["version"]);
  return res.code === 0;
}

const CLI_INSTALL_URL =
  "https://raw.githubusercontent.com/NodeOps-app/createos-cli/main/install.sh";

export async function autoInstallCLI($: any): Promise<boolean> {
  try {
    const shellCmd = `curl -sfL "${CLI_INSTALL_URL}" | sh -`;
    const res = execCmd(shellCmd);
    if (res.code !== 0) return false;
    return isCreateOSInstalled($);
  } catch {
    return false;
  }
}

export async function isLoggedIn($: any): Promise<boolean> {
  const res = await run($, ["-o", "json", "sandbox", "shapes"]);
  return res.code === 0;
}
