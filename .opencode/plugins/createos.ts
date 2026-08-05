import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import * as cli from "../../packages/opencode-plugin/src/cli.ts";

interface ActiveSandbox {
  sandboxId: string;
  cwd: string;
  shape: string;
}

export const CreateOSPlugin: Plugin = async ({ _project, _client, $, directory }) => {
  let active: ActiveSandbox | null = null;
  let initPromise: Promise<void> | null = null;
  const hostCwd = directory;

  if (process.env.CREATEOS_ENABLED === "false") return {};

  // Lazy init — sandbox created on first tool call, not at plugin load
  async function ensureSandbox(): Promise<ActiveSandbox> {
    if (active) return active;
    if (!initPromise) {
      initPromise = (async () => {
        if (!(await cli.isCreateOSInstalled($))) {
          if (!(await cli.autoInstallCLI($)))
            throw new Error(
              "Failed to install CreateOS CLI. Run: curl -sfL https://raw.githubusercontent.com/NodeOps-app/createos-cli/main/install.sh | sh",
            );
        }
        if (!(await cli.isLoggedIn($)))
          throw new Error("Not logged in to CreateOS. Run: createos login");
        const shape = process.env.CREATEOS_SHAPE ?? "s-2vcpu-2gb";
        const rootfs = process.env.CREATEOS_ROOTFS;
        const sandbox = await cli.createSandbox($, { shape, rootfs, ingress: true });
        const cwd = "/root/workspace";
        await cli.sandboxExec($, sandbox.id, `mkdir -p ${cwd}`);
        active = { sandboxId: sandbox.id, cwd, shape };
      })();
    }
    await initPromise;
    if (!active) throw new Error("Sandbox initialization failed");
    return active;
  }

  // --- Pi-style system prompt ---
  function sandboxPrompt(): string {
    const s = active;
    if (!s) return "";
    return `
--- CreateOS Sandbox Environment ---
Sandbox: ${s.sandboxId}
Cwd: ${s.cwd}
Host dir: ${hostCwd}
All commands run remotely in this sandbox. You know the sandbox ID and cwd — never run pwd/hostname to discover them.

CRITICAL: Use sandbox_exec for ALL shell commands. NEVER use the built-in bash tool — it runs on the user's local Mac, not in the sandbox.

Quick rules:
- Shell commands → sandbox_exec (command="your command here")
- Read files in sandbox → sandbox_pull (remote_path="/path/to/file")
- Write files to sandbox → sandbox_push (remote_path="/path/to/file", content="...")
- "mount/sync this dir" → sandbox_sync local_dir="${hostCwd}" remote_dir="/root/project"
- Port access → sandbox_preview_url (public URL) > sandbox_tunnel (localhost) > device VPN (last resort)
- Multi-node → sandbox_network_create + sandbox_create with network + sandbox_exec on other sandboxes
--- End CreateOS ---`;
  }

  // --- All tools ---
  const tools: Record<string, any> = {
    // === PRIMARY TOOL — use for ALL shell commands ===
    sandbox_exec: tool({
      description:
        "Run a shell command inside the CreateOS sandbox. Use this for ALL shell commands — installing packages, running scripts, compiling code, starting servers, checking system info. NEVER use the built-in bash tool.",
      args: {
        command: tool.schema.string().describe("Shell command to run inside the sandbox"),
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe("Target sandbox ID (defaults to the active sandbox)"),
      },
      async execute(args) {
        const s = await ensureSandbox();
        const target = args.sandbox_id ?? s.sandboxId;
        const res = await cli.sandboxExec($, target, args.command);
        const parts: string[] = [];
        if (res.stdout.trim()) parts.push(res.stdout.trim());
        if (res.stderr.trim()) parts.push(`STDERR:\n${res.stderr.trim()}`);
        if (res.code !== 0) parts.push(`Exit code: ${res.code}`);
        return parts.join("\n") || "(no output)";
      },
    }),

    // === File transfer ===
    sandbox_pull: tool({
      description: "Read/download a file from the sandbox. Returns the file content as text.",
      args: {
        remote_path: tool.schema.string().describe("Absolute path to the file inside the sandbox"),
      },
      async execute(args) {
        const s = await ensureSandbox();
        return await cli.pullFile($, s.sandboxId, args.remote_path);
      },
    }),

    sandbox_push: tool({
      description: "Write/upload content to a file in the sandbox. Creates or overwrites the file.",
      args: {
        remote_path: tool.schema.string().describe("Absolute path to the file inside the sandbox"),
        content: tool.schema.string().describe("File content to write"),
      },
      async execute(args) {
        const s = await ensureSandbox();
        await cli.pushFile($, s.sandboxId, args.content, args.remote_path);
        return `Written: ${args.remote_path}`;
      },
    }),

    // === Sandbox lifecycle ===
    sandbox_info: tool({
      description: "Get the current sandbox status, IP address, shape, region, and ingress URL.",
      args: {
        sandbox_id: tool.schema.string().optional().describe("Sandbox ID (defaults to current)"),
      },
      async execute(args) {
        const s = await ensureSandbox();
        const info = await cli.getSandbox($, args.sandbox_id ?? s.sandboxId);
        return [
          `ID: ${info.id}`,
          `Status: ${info.status}`,
          `Name: ${info.name ?? "n/a"}`,
          `IP: ${info.ip ?? "n/a"}`,
          `Shape: ${(info as any).shape ?? "n/a"}`,
          `Region: ${info.region ?? "n/a"}`,
          info.ingress_url_template ? `Ingress: ${info.ingress_url_template}` : null,
        ]
          .filter(Boolean)
          .join("\n");
      },
    }),

    sandbox_create: tool({
      description:
        "Create an additional sandbox. Use when the user needs multiple sandboxes — multi-node clusters, separate database servers, microservice setups.",
      args: {
        shape: tool.schema
          .string()
          .optional()
          .describe("VM size (default: s-2vcpu-2gb). Use sandbox_shapes to see options."),
        rootfs: tool.schema.string().optional().describe("Base image (default: devbox:1)"),
        name: tool.schema.string().optional().describe("Friendly name for the sandbox"),
        networks: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("Network names to join at creation"),
      },
      async execute(args) {
        await ensureSandbox();
        const sb = await cli.createSandbox($, {
          shape: args.shape,
          rootfs: args.rootfs,
          name: args.name,
          networks: args.networks,
          ingress: true,
        });
        const lines = [`Sandbox created: ${sb.id}`, `IP: ${sb.ip ?? "pending"}`];
        if (sb.ingress_url_template) lines.push(`Ingress: ${sb.ingress_url_template}`);
        if (args.networks?.length) lines.push(`Networks: ${args.networks.join(", ")}`);
        return lines.join("\n");
      },
    }),

    sandbox_list: tool({
      description: "List all sandboxes owned by the user, including paused and running ones.",
      args: {},
      async execute() {
        await ensureSandbox();
        const sbs = await cli.listSandboxes($);
        if (!sbs.length) return "No sandboxes found.";
        return sbs.map((s) => `${s.id}  ${s.status}  ${s.name ?? ""}  ${s.ip ?? ""}`).join("\n");
      },
    }),

    sandbox_pause: tool({
      description:
        "Pause the sandbox, saving its state. The sandbox becomes unavailable until resumed.",
      args: {
        sandbox_id: tool.schema.string().optional().describe("Sandbox ID (defaults to current)"),
      },
      async execute(args) {
        const s = await ensureSandbox();
        await cli.pauseSandbox($, args.sandbox_id ?? s.sandboxId);
        return `Sandbox pausing. It will be unavailable until resumed.`;
      },
    }),

    sandbox_resume: tool({
      description: "Resume a paused sandbox back to running state.",
      args: { sandbox_id: tool.schema.string().describe("ID of the paused sandbox to resume") },
      async execute(args) {
        await cli.resumeSandbox($, args.sandbox_id);
        return `Sandbox ${args.sandbox_id} resuming.`;
      },
    }),

    sandbox_fork: tool({
      description:
        "Clone a paused sandbox into a brand-new sandbox with the same state. Source must be paused first.",
      args: {
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe("Sandbox ID to fork (defaults to current)"),
      },
      async execute(args) {
        const s = await ensureSandbox();
        const f = await cli.forkSandbox($, args.sandbox_id ?? s.sandboxId);
        return `Forked → ${f.id} (${f.status}). IP: ${f.ip ?? "pending"}`;
      },
    }),

    sandbox_destroy: tool({
      description: "Permanently delete a sandbox. This cannot be undone.",
      args: { sandbox_id: tool.schema.string().describe("ID of the sandbox to destroy") },
      async execute(args) {
        await cli.destroySandbox($, args.sandbox_id);
        return `Sandbox ${args.sandbox_id} destroyed.`;
      },
    }),

    // === Config ===
    sandbox_ingress: tool({
      description: "Enable or disable the public HTTPS URL for a sandbox.",
      args: {
        enabled: tool.schema.boolean().describe("true to enable, false to disable"),
        sandbox_id: tool.schema.string().optional().describe("Sandbox ID (defaults to current)"),
      },
      async execute(args) {
        const s = await ensureSandbox();
        await cli.editSandbox($, args.sandbox_id ?? s.sandboxId, { ingress: args.enabled });
        if (args.enabled) {
          const info = await cli.getSandbox($, args.sandbox_id ?? s.sandboxId);
          return `Ingress enabled.${info.ingress_url_template ? ` URL: ${info.ingress_url_template}` : ""}`;
        }
        return "Ingress disabled.";
      },
    }),

    sandbox_firewall: tool({
      description: "Set egress firewall rules. Pass an empty list to allow all outbound traffic.",
      args: {
        rules: tool.schema
          .array(tool.schema.string())
          .describe('Allowed domains or IPs (e.g. ["pypi.org", "1.1.1.1:53"]). Empty = allow all.'),
        sandbox_id: tool.schema.string().optional().describe("Sandbox ID (defaults to current)"),
      },
      async execute(args) {
        const s = await ensureSandbox();
        await cli.editSandbox($, args.sandbox_id ?? s.sandboxId, { egress: args.rules });
        return args.rules.length
          ? `Firewall set: ${args.rules.join(", ")}`
          : "Firewall cleared — all outbound allowed.";
      },
    }),

    sandbox_bandwidth: tool({
      description: "Check bandwidth usage and quota for the sandbox.",
      args: {
        sandbox_id: tool.schema.string().optional().describe("Sandbox ID (defaults to current)"),
      },
      async execute(args) {
        const s = await ensureSandbox();
        const bw = (await cli.getBandwidth($, args.sandbox_id ?? s.sandboxId)) as any;
        if (!bw) return "No bandwidth data available.";
        return `Used: ${bw.used_bytes ?? 0} / Quota: ${bw.quota_bytes ?? 0}${bw.capped ? " — CAPPED" : ""}`;
      },
    }),

    sandbox_shapes: tool({
      description: "List available sandbox sizes (vCPU, RAM) before creating a new sandbox.",
      args: {},
      async execute() {
        return JSON.stringify(await cli.listShapes($), null, 2);
      },
    }),

    sandbox_images: tool({
      description: "List available base images (rootfs) for sandbox creation.",
      args: {},
      async execute() {
        return JSON.stringify(await cli.listRootfs($), null, 2);
      },
    }),

    // === Ports & Connectivity ===
    sandbox_preview_url: tool({
      description:
        "Get the public HTTPS URL for a port served inside the sandbox. Use after starting a server to give the user a clickable link.",
      args: { port: tool.schema.number().describe("The port the server listens on") },
      async execute(args) {
        const s = await ensureSandbox();
        const info = await cli.getSandbox($, s.sandboxId);
        if (!info.ingress_url_template)
          return "Ingress not enabled. Use sandbox_ingress to enable it first.";
        return `Preview URL for port ${args.port}: ${info.ingress_url_template.replace("<port>", String(args.port))}`;
      },
    }),

    sandbox_tunnel: tool({
      description:
        "Forward a sandbox port to localhost on the user's machine. No setup needed. Prefer sandbox_preview_url for sharing.",
      args: {
        remote_port: tool.schema.number().describe("Port inside the sandbox"),
        local_port: tool.schema
          .number()
          .optional()
          .describe("Local port (defaults to same as remote)"),
      },
      async execute(args) {
        const s = await ensureSandbox();
        const r = await cli.startTunnel($, s.sandboxId, args.remote_port, args.local_port);
        return `Port forward: localhost:${r.localPort} → sandbox:${args.remote_port}\nAccess at: http://localhost:${r.localPort}`;
      },
    }),

    sandbox_sync: tool({
      description:
        "Mount/sync a local directory from the user's machine into the sandbox. Bidirectional by default.",
      args: {
        local_dir: tool.schema.string().describe("Absolute path to the local directory"),
        remote_dir: tool.schema
          .string()
          .describe("Absolute path inside the sandbox (e.g. /root/project)"),
        mode: tool.schema
          .string()
          .optional()
          .describe('Sync mode: "two-way" (default), "one-way", or "mirror"'),
        exclude: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe('Patterns to exclude (e.g. ["node_modules", "*.log"])'),
      },
      async execute(args) {
        const s = await ensureSandbox();
        const r = await cli.startSync($, s.sandboxId, args.local_dir, args.remote_dir, {
          mode: args.mode,
          exclude: args.exclude,
        });
        return `Sync started: ${args.local_dir} ↔ sandbox:${args.remote_dir}${args.mode ? ` (${args.mode})` : ""}\nPID: ${r.pid}`;
      },
    }),

    // === Networks ===
    sandbox_network_create: tool({
      description: "Create a new private network for sandbox-to-sandbox communication.",
      args: { name: tool.schema.string().describe("Network name") },
      async execute(args) {
        const n = await cli.createNetwork($, args.name);
        return `Network created: ${n.name} (${n.id})`;
      },
    }),
    sandbox_network_list: tool({
      description: "List all private networks.",
      args: {},
      async execute() {
        const nets = await cli.listNetworks($);
        if (!nets.length) return "No networks.";
        return nets.map((n) => `${n.name} (${n.id}) · ${n.member_count ?? 0} members`).join("\n");
      },
    }),
    sandbox_network_show: tool({
      description: "Show network details including member sandbox IPs.",
      args: { name: tool.schema.string().describe("Network name or ID") },
      async execute(args) {
        const net = await cli.getNetwork($, args.name);
        const lines = [`Network: ${net.name} (${net.id})`];
        if (net.members?.length) {
          lines.push("Members:");
          for (const m of net.members)
            lines.push(`  ${m.sandbox_id} · ${m.status} · ${m.ip}${m.name ? ` · ${m.name}` : ""}`);
        } else lines.push("No members");
        return lines.join("\n");
      },
    }),
    sandbox_network_attach: tool({
      description: "Attach the current sandbox to a private network.",
      args: { name: tool.schema.string().describe("Network name or ID") },
      async execute(args) {
        const s = await ensureSandbox();
        await cli.attachNetwork($, s.sandboxId, args.name);
        return `Attached to "${args.name}".`;
      },
    }),
    sandbox_network_detach: tool({
      description: "Detach the current sandbox from a private network.",
      args: { name: tool.schema.string().describe("Network name or ID") },
      async execute(args) {
        const s = await ensureSandbox();
        await cli.detachNetwork($, s.sandboxId, args.name);
        return `Detached from "${args.name}".`;
      },
    }),
    sandbox_network_delete: tool({
      description: "Delete a private network. Detach all sandboxes first.",
      args: { name: tool.schema.string().describe("Network name or ID") },
      async execute(args) {
        await cli.deleteNetwork($, args.name);
        return `Network "${args.name}" deleted.`;
      },
    }),

    // === Disks ===
    sandbox_disk_create: tool({
      description:
        "Register an S3-compatible bucket as a persistent disk that can be mounted into sandboxes.",
      args: {
        name: tool.schema.string().describe("Disk name"),
        bucket: tool.schema.string().describe("S3 bucket name"),
        endpoint: tool.schema.string().describe("S3 endpoint URL"),
        access_key: tool.schema.string().describe("Access key ID"),
        secret_key: tool.schema.string().describe("Secret access key"),
        region: tool.schema.string().optional().describe("AWS region"),
        path_style: tool.schema.boolean().optional().describe("Use path-style URLs (for MinIO)"),
      },
      async execute(args) {
        const d = await cli.createDisk($, {
          name: args.name,
          bucket: args.bucket,
          endpoint: args.endpoint,
          accessKey: args.access_key,
          secretKey: args.secret_key,
          region: args.region,
          pathStyle: args.path_style,
        });
        return `Disk created: ${d.name} (${d.id})`;
      },
    }),
    sandbox_disk_list: tool({
      description: "List all registered S3 disks.",
      args: {},
      async execute() {
        const disks = await cli.listDisks($);
        if (!disks.length) return "No disks.";
        return disks
          .map(
            (d) => `${d.name} (${d.id})${d.config?.bucket ? ` · bucket: ${d.config.bucket}` : ""}`,
          )
          .join("\n");
      },
    }),
    sandbox_disk_show: tool({
      description: "Show details for a registered disk.",
      args: { name: tool.schema.string().describe("Disk name or ID") },
      async execute(args) {
        return JSON.stringify(await cli.getDisk($, args.name), null, 2);
      },
    }),
    sandbox_disk_delete: tool({
      description: "Delete a registered disk. Must be detached from all sandboxes first.",
      args: { name: tool.schema.string().describe("Disk name or ID") },
      async execute(args) {
        await cli.deleteDisk($, args.name);
        return `Disk "${args.name}" deleted.`;
      },
    }),
    sandbox_disk_attach: tool({
      description: "Mount a registered disk into a running sandbox at a given path.",
      args: {
        disk_name: tool.schema.string().describe("Disk name or ID"),
        mount_path: tool.schema.string().describe("Absolute mount path (e.g. /mnt/data)"),
        sandbox_id: tool.schema.string().optional().describe("Sandbox ID (defaults to current)"),
      },
      async execute(args) {
        const s = await ensureSandbox();
        await cli.attachDisk($, args.sandbox_id ?? s.sandboxId, args.disk_name, args.mount_path);
        return `Disk "${args.disk_name}" mounted at ${args.mount_path}`;
      },
    }),
    sandbox_disk_detach: tool({
      description: "Unmount a disk from a sandbox. The bucket data is untouched.",
      args: {
        disk_name: tool.schema.string().describe("Disk name or ID"),
        mount_path: tool.schema.string().describe("Mount path to detach"),
        sandbox_id: tool.schema.string().optional().describe("Sandbox ID (defaults to current)"),
      },
      async execute(args) {
        const s = await ensureSandbox();
        await cli.detachDisk($, args.sandbox_id ?? s.sandboxId, args.disk_name, args.mount_path);
        return `Disk "${args.disk_name}" detached from ${args.mount_path}`;
      },
    }),

    // === Device VPN ===
    sandbox_device_register: tool({
      description:
        "Register the user's machine as a device for direct sandbox access. One-time setup. Requires wireguard-tools.",
      args: {
        name: tool.schema.string().optional().describe("Device name (defaults to hostname)"),
      },
      async execute(args) {
        const devs = await cli.listDevices($);
        if (devs.length)
          return `Device already registered: ${devs[0].name} (${devs[0].client_ip ?? "n/a"})`;
        const out = await cli.registerDevice($, args.name);
        return out || "Device registered.";
      },
    }),
    sandbox_device_status: tool({
      description: "Check if the user has a registered device for direct sandbox access.",
      args: {},
      async execute() {
        const devs = await cli.listDevices($);
        if (!devs.length) return "No device registered. Use sandbox_device_register first.";
        return devs
          .map((d) => `${d.name} · ${d.id ?? d.device_id} · IP: ${d.client_ip ?? "n/a"}`)
          .join("\n");
      },
    }),
    sandbox_vpn_up: tool({
      description:
        "Returns the command the user must run in a separate terminal to start the VPN tunnel. Requires sudo.",
      args: {},
      async execute() {
        return "The user needs to run this command in a separate terminal (requires sudo):\n\n  createos sb vpn up\n\nOnce connected, sandbox IPs are reachable directly.";
      },
    }),
    sandbox_device_attach: tool({
      description: "Attach the user's device to a network for direct IP access to sandboxes.",
      args: { network: tool.schema.string().describe("Network name or ID") },
      async execute(args) {
        const devs = await cli.listDevices($);
        if (!devs.length)
          throw new Error("No device registered. Use sandbox_device_register first.");
        const devId = devs[0].id ?? devs[0].device_id!;
        await cli.attachDeviceToNetwork($, devId, args.network);
        return `Device attached to "${args.network}".\nRun \`createos sb vpn up\` to access sandbox IPs directly.`;
      },
    }),
    sandbox_device_detach: tool({
      description: "Remove the user's device from a network.",
      args: { network: tool.schema.string().describe("Network name or ID") },
      async execute(args) {
        const devs = await cli.listDevices($);
        if (!devs.length) throw new Error("No device registered.");
        const devId = devs[0].id ?? devs[0].device_id!;
        await cli.detachDeviceFromNetwork($, devId, args.network);
        return `Device detached from "${args.network}".`;
      },
    }),
  };

  return {
    // Inject Pi-style prompt into all agents
    config: async (input: any) => {
      // Trigger sandbox creation early so prompt has the ID
      try {
        await ensureSandbox();
      } catch {}

      const prompt = sandboxPrompt();
      if (!prompt) return;

      for (const agentName of ["build", "plan", "general", "explore"]) {
        if (input.agent?.[agentName]) {
          const existing = input.agent[agentName].prompt ?? "";
          if (!existing.includes("CreateOS Sandbox")) {
            input.agent[agentName] = {
              ...input.agent[agentName],
              prompt: existing + "\n" + prompt,
            };
          }
        }
      }
    },

    "experimental.session.compacting": async (_input: any, output: any) => {
      const prompt = sandboxPrompt();
      if (prompt) output.context.push(prompt);
    },

    event: async ({ event }: any) => {
      if (event.type === "session.deleted" && active) {
        try {
          await cli.cleanupTempKey($);
        } catch {}
        try {
          await cli.destroySandbox($, active.sandboxId);
        } catch {}
        active = null;
      }
    },

    tool: tools,
  };
};
