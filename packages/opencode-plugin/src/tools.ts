/**
 * OpenCode plugin tools — ports all 33 tools from the Pi extension.
 *
 * Pi used `pi.registerTool({ name, parameters: Type.Object(...), execute })`.
 * OpenCode uses `tool({ description, args, execute })` returned in a tool map.
 */

import { tool } from "@opencode-ai/plugin"
import * as cli from "./cli.ts"
import { shellQuote, joinPath } from "./util.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolSandbox {
  sandboxId: string
  cwd: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireSandbox(getActive: () => ToolSandbox | null): ToolSandbox {
  const active = getActive()
  if (!active) {
    throw new Error(
      "No active CreateOS sandbox. Please enable CreateOS first by creating or selecting a sandbox.",
    )
  }
  return active
}

function fmtBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createTools($: any, getActive: () => ToolSandbox | null) {
  return {
    // =====================================================================
    // GROUP 1: Built-in Tool Overrides (7 tools)
    // =====================================================================

    bash: tool({
      description:
        "Run a shell command in the active CreateOS sandbox. When a sandbox is active all shell commands are executed remotely inside it. If no sandbox is active an error is returned asking the user to enable CreateOS.",
      args: {
        command: tool.schema.string().describe("The shell command to run"),
        timeout: tool.schema
          .number()
          .optional()
          .describe("Optional timeout in seconds for the command"),
      },
      async execute(args) {
        const active = requireSandbox(getActive)
        const result = await cli.sandboxExec($, active.sandboxId, args.command)
        const parts: string[] = []
        if (result.stdout.trim()) parts.push(result.stdout.trim())
        if (result.stderr.trim()) parts.push(`STDERR:\n${result.stderr.trim()}`)
        if (result.code !== 0) parts.push(`Exit code: ${result.code}`)
        return parts.join("\n") || "(no output)"
      },
    }),

    read: tool({
      description:
        "Read a file from the active CreateOS sandbox. Pulls the file content from the remote sandbox filesystem. If no sandbox is active an error is returned.",
      args: {
        filePath: tool.schema
          .string()
          .describe("Absolute or relative path to the file to read"),
        limit: tool.schema
          .number()
          .optional()
          .describe("Maximum number of lines to return"),
        offset: tool.schema
          .number()
          .optional()
          .describe("Line number to start reading from (1-based)"),
      },
      async execute(args) {
        const active = requireSandbox(getActive)
        const content = await cli.pullFile($, active.sandboxId, args.filePath)
        if (args.offset || args.limit) {
          const lines = content.split("\n")
          const start = (args.offset ?? 1) - 1
          const end = args.limit ? start + args.limit : undefined
          return lines.slice(start, end).join("\n")
        }
        return content
      },
    }),

    write: tool({
      description:
        "Write content to a file in the active CreateOS sandbox. Pushes the content to the remote sandbox filesystem, creating or overwriting the file. If no sandbox is active an error is returned.",
      args: {
        filePath: tool.schema
          .string()
          .describe("Absolute or relative path to the file to write"),
        content: tool.schema
          .string()
          .describe("The full content to write to the file"),
      },
      async execute(args) {
        const active = requireSandbox(getActive)
        await cli.pushFile($, active.sandboxId, args.content, args.filePath)
        return `File written: ${args.filePath}`
      },
    }),

    edit: tool({
      description:
        "Edit a file in the active CreateOS sandbox by replacing a specific string with a new string. Pulls the file, applies the substitution, and pushes it back. If no sandbox is active an error is returned.",
      args: {
        filePath: tool.schema
          .string()
          .describe("Absolute or relative path to the file to edit"),
        old_string: tool.schema
          .string()
          .describe(
            "The exact string in the file to replace. Must match exactly, including whitespace and indentation.",
          ),
        new_string: tool.schema
          .string()
          .describe("The string to replace old_string with"),
      },
      async execute(args) {
        const active = requireSandbox(getActive)
        const content = await cli.pullFile($, active.sandboxId, args.filePath)
        if (!content.includes(args.old_string)) {
          throw new Error(
            `old_string not found in ${args.filePath}. Make sure it matches exactly, including whitespace and indentation.`,
          )
        }
        const updated = content.replace(args.old_string, args.new_string)
        await cli.pushFile($, active.sandboxId, updated, args.filePath)
        return `File edited: ${args.filePath}`
      },
    }),

    ls: tool({
      description:
        "List the contents of a directory in the active CreateOS sandbox. If no sandbox is active an error is returned.",
      args: {
        path: tool.schema
          .string()
          .optional()
          .describe(
            "Directory path to list. Defaults to the current working directory.",
          ),
      },
      async execute(args) {
        const active = requireSandbox(getActive)
        const target = args.path ?? "."
        const result = await cli.sandboxExec(
          $,
          active.sandboxId,
          `ls -1A ${shellQuote(target)}`,
        )
        if (result.code !== 0) {
          throw new Error(
            result.stderr.trim() || `ls failed with code ${result.code}`,
          )
        }
        return result.stdout.trim() || "(empty directory)"
      },
    }),

    find: tool({
      description:
        "Find files by name or glob pattern in the active CreateOS sandbox. Uses ripgrep (rg) when available, falling back to the find command. Excludes .git and node_modules by default. If no sandbox is active an error is returned.",
      args: {
        pattern: tool.schema
          .string()
          .describe(
            "Glob pattern to match file names (e.g. '*.ts', 'README*')",
          ),
        path: tool.schema
          .string()
          .optional()
          .describe("Directory to search in. Defaults to '.'"),
        limit: tool.schema
          .number()
          .optional()
          .describe(
            "Maximum number of results to return. Defaults to 100.",
          ),
      },
      async execute(args) {
        const active = requireSandbox(getActive)
        const searchPath = args.path ?? "."
        const maxResults = args.limit ?? 100

        // Extract basename from pattern for the find fallback
        const basename = args.pattern.split("/").pop() ?? args.pattern

        const rgCmd = `rg --files --hidden -g '!**/.git/**' -g '!**/node_modules/**' -g ${shellQuote(args.pattern)} ${shellQuote(searchPath)}`
        const findCmd = `find ${shellQuote(searchPath)} -type f -name ${shellQuote(basename)} ! -path '*/.git/*' ! -path '*/node_modules/*'`
        const fullCmd = `if command -v rg > /dev/null 2>&1; then ${rgCmd}; else ${findCmd}; fi | head -n ${maxResults}`

        const result = await cli.sandboxExec($, active.sandboxId, fullCmd)
        if (result.code !== 0 && !result.stdout.trim()) {
          throw new Error(
            result.stderr.trim() || `find failed with code ${result.code}`,
          )
        }
        return result.stdout.trim() || "No files found."
      },
    }),

    grep: tool({
      description:
        "Search file contents by pattern in the active CreateOS sandbox. Uses ripgrep (rg) when available, falling back to grep. If no sandbox is active an error is returned.",
      args: {
        pattern: tool.schema
          .string()
          .describe("Regular expression pattern to search for"),
        path: tool.schema
          .string()
          .optional()
          .describe("File or directory to search in. Defaults to '.'"),
        glob: tool.schema
          .string()
          .optional()
          .describe(
            "Only search files matching this glob (e.g. '*.ts'). Only used with rg.",
          ),
        ignoreCase: tool.schema
          .boolean()
          .optional()
          .describe("Case-insensitive search"),
        literal: tool.schema
          .boolean()
          .optional()
          .describe("Treat pattern as a literal string, not a regex"),
        context: tool.schema
          .number()
          .optional()
          .describe("Number of context lines to show around each match"),
        limit: tool.schema
          .number()
          .optional()
          .describe(
            "Maximum number of output lines to return. Defaults to 200.",
          ),
      },
      async execute(args) {
        const active = requireSandbox(getActive)
        const searchPath = args.path ?? "."
        const maxLines = args.limit ?? 200

        // Build rg flags
        const rgFlags: string[] = [
          "--line-number",
          "--no-heading",
          "--color=never",
          "--hidden",
        ]
        const grepFlags: string[] = ["-rnI"]

        if (args.ignoreCase) {
          rgFlags.push("-i")
          grepFlags.push("-i")
        }
        if (args.literal) {
          rgFlags.push("-F")
          grepFlags.push("-F")
        }
        if (args.context !== undefined) {
          rgFlags.push(`-C ${args.context}`)
          grepFlags.push(`-C ${args.context}`)
        }
        if (args.glob) {
          rgFlags.push(`-g ${shellQuote(args.glob)}`)
        }

        const rgCmd = `rg ${rgFlags.join(" ")} -- ${shellQuote(args.pattern)} ${shellQuote(searchPath)}`
        const grepCmd = `grep ${grepFlags.join(" ")} -- ${shellQuote(args.pattern)} ${shellQuote(searchPath)}`
        const fullCmd = `if command -v rg > /dev/null 2>&1; then ${rgCmd}; else ${grepCmd}; fi | head -n ${maxLines}`

        const result = await cli.sandboxExec($, active.sandboxId, fullCmd)
        if (result.code !== 0 && !result.stdout.trim()) {
          // Exit code 1 from rg/grep means no matches — not a real error
          if (result.code === 1) return "No matches found."
          throw new Error(
            result.stderr.trim() || `grep failed with code ${result.code}`,
          )
        }
        return result.stdout.trim() || "No matches found."
      },
    }),

    // =====================================================================
    // GROUP 2: Sandbox-Specific Tools (26 tools)
    // =====================================================================

    sandbox_create: tool({
      description:
        "Create a new CreateOS sandbox. Returns the sandbox ID, IP address, shape, and ingress URL once ready.",
      args: {
        shape: tool.schema
          .string()
          .optional()
          .describe(
            "VM size/shape (e.g. 's-2vcpu-2gb'). Defaults to 's-2vcpu-2gb'.",
          ),
        rootfs: tool.schema
          .string()
          .optional()
          .describe("Base image name to use for the sandbox"),
        name: tool.schema
          .string()
          .optional()
          .describe("Human-readable name for the sandbox"),
        networks: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("Network names to attach to the sandbox at creation time"),
      },
      async execute(args) {
        const info = await cli.createSandbox($, {
          shape: args.shape,
          rootfs: args.rootfs,
          name: args.name,
          networks: args.networks,
        })
        const lines = [
          `Sandbox created.`,
          `  ID:     ${info.id}`,
          `  Status: ${info.status}`,
        ]
        if (info.ip) lines.push(`  IP:     ${info.ip}`)
        if ((info as any).shape) lines.push(`  Shape:  ${(info as any).shape}`)
        if (info.ingress_url_template)
          lines.push(`  Ingress: ${info.ingress_url_template}`)
        return lines.join("\n")
      },
    }),

    sandbox_exec: tool({
      description:
        "Run a shell command on a specific sandbox by ID. Use this when you need to target a sandbox that is not the currently active one.",
      args: {
        sandbox_id: tool.schema
          .string()
          .describe("The sandbox ID to execute the command on"),
        command: tool.schema.string().describe("The shell command to run"),
      },
      async execute(args) {
        const result = await cli.sandboxExec($, args.sandbox_id, args.command)
        const parts: string[] = []
        if (result.stdout.trim()) parts.push(result.stdout.trim())
        if (result.stderr.trim()) parts.push(`STDERR:\n${result.stderr.trim()}`)
        if (result.code !== 0) parts.push(`Exit code: ${result.code}`)
        return parts.join("\n") || "(no output)"
      },
    }),

    sandbox_info: tool({
      description:
        "Get detailed status information about a sandbox including its ID, status, name, IP address, shape, region, and ingress URL.",
      args: {
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe(
            "Sandbox ID to inspect. Defaults to the currently active sandbox.",
          ),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId
        const info = await cli.getSandbox($, id)
        const lines = [
          `ID:      ${info.id}`,
          `Status:  ${info.status}`,
        ]
        if (info.name) lines.push(`Name:    ${info.name}`)
        if (info.ip) lines.push(`IP:      ${info.ip}`)
        if ((info as any).shape) lines.push(`Shape:   ${(info as any).shape}`)
        if (info.region) lines.push(`Region:  ${info.region}`)
        if (info.ingress_url_template)
          lines.push(`Ingress: ${info.ingress_url_template}`)
        return lines.join("\n")
      },
    }),

    sandbox_list: tool({
      description:
        "List all sandboxes in the current CreateOS account, including their IDs, names, and statuses.",
      args: {},
      async execute() {
        const sandboxes = await cli.listSandboxes($)
        if (sandboxes.length === 0) return "No sandboxes found."
        return sandboxes
          .map((sb) => {
            const parts = [sb.id, sb.status]
            if (sb.name) parts.push(sb.name)
            if (sb.ip) parts.push(sb.ip)
            return parts.join("  ")
          })
          .join("\n")
      },
    }),

    sandbox_pause: tool({
      description:
        "Pause a running sandbox. The sandbox state is preserved and can be resumed later. Paused sandboxes do not consume compute resources.",
      args: {
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe(
            "Sandbox ID to pause. Defaults to the currently active sandbox.",
          ),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId
        await cli.pauseSandbox($, id)
        return `Sandbox ${id} paused.`
      },
    }),

    sandbox_resume: tool({
      description:
        "Resume a previously paused sandbox, restoring it to a running state.",
      args: {
        sandbox_id: tool.schema
          .string()
          .describe("The sandbox ID to resume"),
      },
      async execute(args) {
        await cli.resumeSandbox($, args.sandbox_id)
        return `Sandbox ${args.sandbox_id} resumed.`
      },
    }),

    sandbox_fork: tool({
      description:
        "Clone a paused sandbox into a new sandbox. The new sandbox is an exact copy of the original at the point it was paused.",
      args: {
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe(
            "Sandbox ID to fork. Defaults to the currently active sandbox.",
          ),
        paused: tool.schema
          .boolean()
          .optional()
          .describe(
            "If true, pause the source sandbox before forking (it must be paused to fork).",
          ),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId
        if (args.paused) {
          await cli.pauseSandbox($, id)
        }
        const forked = await cli.forkSandbox($, id)
        return `Forked sandbox ${id} -> new sandbox ${forked.id} (status: ${forked.status})`
      },
    }),

    sandbox_destroy: tool({
      description:
        "Permanently delete a sandbox. This is irreversible. All data in the sandbox will be lost.",
      args: {
        sandbox_id: tool.schema
          .string()
          .describe("The sandbox ID to destroy"),
      },
      async execute(args) {
        await cli.destroySandbox($, args.sandbox_id)
        return `Sandbox ${args.sandbox_id} destroyed.`
      },
    }),

    sandbox_ingress: tool({
      description:
        "Toggle public HTTPS ingress for a sandbox. When enabled, the sandbox gets a public URL that can be used to access services running inside it.",
      args: {
        enabled: tool.schema
          .boolean()
          .describe("Set to true to enable ingress, false to disable"),
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe(
            "Sandbox ID to configure. Defaults to the currently active sandbox.",
          ),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId
        await cli.editSandbox($, id, { ingress: args.enabled })
        if (args.enabled) {
          const info = await cli.getSandbox($, id)
          return `Ingress enabled for sandbox ${id}.${info.ingress_url_template ? `\nURL template: ${info.ingress_url_template}` : ""}`
        }
        return `Ingress disabled for sandbox ${id}.`
      },
    }),

    sandbox_firewall: tool({
      description:
        "Set egress firewall rules for a sandbox. Rules control which external destinations the sandbox can reach. Each rule is a string like 'allow tcp 443 example.com' or 'deny all'.",
      args: {
        rules: tool.schema
          .array(tool.schema.string())
          .describe("List of egress firewall rules to apply"),
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe(
            "Sandbox ID to configure. Defaults to the currently active sandbox.",
          ),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId
        await cli.editSandbox($, id, { egress: args.rules })
        return `Egress rules updated for sandbox ${id}:\n${args.rules.map((r) => `  - ${r}`).join("\n")}`
      },
    }),

    sandbox_bandwidth: tool({
      description:
        "Check bandwidth usage for a sandbox, showing bytes used, quota, remaining allowance, and whether the sandbox is bandwidth-capped.",
      args: {
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe(
            "Sandbox ID to check. Defaults to the currently active sandbox.",
          ),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId
        const bw = (await cli.getBandwidth($, id)) as any
        if (!bw) return `No bandwidth data available for sandbox ${id}.`
        const used = bw.used_bytes ?? bw.used ?? 0
        const quota = bw.quota_bytes ?? bw.quota ?? 0
        const remaining = Math.max(0, quota - used)
        const capped = bw.capped ?? remaining <= 0
        return [
          `Bandwidth for sandbox ${id}:`,
          `  Used:      ${fmtBytes(used)}`,
          `  Quota:     ${fmtBytes(quota)}`,
          `  Remaining: ${fmtBytes(remaining)}`,
          `  Capped:    ${capped ? "yes" : "no"}`,
        ].join("\n")
      },
    }),

    sandbox_shapes: tool({
      description:
        "List all available sandbox shapes (VM sizes). Shows the CPU, memory, and other resource specifications for each shape.",
      args: {},
      async execute() {
        const shapes = await cli.listShapes($)
        if (!shapes || shapes.length === 0) return "No shapes available."
        return JSON.stringify(shapes, null, 2)
      },
    }),

    sandbox_images: tool({
      description:
        "List all available base images (rootfs) that can be used when creating a sandbox.",
      args: {},
      async execute() {
        const images = await cli.listRootfs($)
        if (!images || images.length === 0) return "No images available."
        return JSON.stringify(images, null, 2)
      },
    }),

    sandbox_preview_url: tool({
      description:
        "Get the public HTTPS URL for a specific port on the active sandbox. Requires ingress to be enabled on the sandbox.",
      args: {
        port: tool.schema
          .number()
          .describe("The port number to get the preview URL for"),
      },
      async execute(args) {
        const active = requireSandbox(getActive)
        const info = await cli.getSandbox($, active.sandboxId)
        if (!info.ingress_url_template) {
          return "Ingress is not enabled on this sandbox. Enable it first with sandbox_ingress."
        }
        const url = info.ingress_url_template.replace(
          "<port>",
          String(args.port),
        )
        return `Preview URL for port ${args.port}: ${url}`
      },
    }),

    sandbox_tunnel: tool({
      description:
        "Create a port-forwarding tunnel from the sandbox to localhost. Maps a remote port on the sandbox to a local port on the host machine.",
      args: {
        remote_port: tool.schema
          .number()
          .describe("The port on the sandbox to forward"),
        local_port: tool.schema
          .number()
          .optional()
          .describe(
            "The local port to listen on. Defaults to the same as remote_port.",
          ),
      },
      async execute(args) {
        const active = requireSandbox(getActive)
        const result = await cli.startTunnel(
          $,
          active.sandboxId,
          args.remote_port,
          args.local_port,
        )
        return `Tunnel established: localhost:${result.localPort} -> sandbox:${args.remote_port} (PID ${result.pid})`
      },
    }),

    sandbox_sync: tool({
      description:
        "Start a bidirectional file sync session between a local directory and a directory inside the sandbox using mutagen.",
      args: {
        local_dir: tool.schema
          .string()
          .describe("Local directory path to sync from"),
        remote_dir: tool.schema
          .string()
          .describe("Remote directory path inside the sandbox to sync to"),
        mode: tool.schema
          .string()
          .optional()
          .describe(
            "Sync mode. Currently unused, reserved for future use.",
          ),
        exclude: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe(
            "List of glob patterns to exclude from sync (e.g. 'node_modules', '.git')",
          ),
      },
      async execute(args) {
        const active = requireSandbox(getActive)
        const result = await cli.startSync(
          $,
          active.sandboxId,
          args.local_dir,
          args.remote_dir,
          { mode: args.mode, exclude: args.exclude },
        )
        return `Sync started: ${args.local_dir} <-> sandbox:${args.remote_dir}${args.mode ? ` (${args.mode})` : ""}\nPID: ${result.pid}`
      },
    }),

    // ----- Networks -----

    sandbox_network_create: tool({
      description:
        "Create a new private network that sandboxes can be attached to for secure inter-sandbox communication.",
      args: {
        name: tool.schema.string().describe("Name for the new network"),
      },
      async execute(args) {
        const net = await cli.createNetwork($, args.name)
        return `Network created.\n  ID:   ${net.id}\n  Name: ${net.name ?? args.name}`
      },
    }),

    sandbox_network_list: tool({
      description: "List all private networks in the current CreateOS account.",
      args: {},
      async execute() {
        const nets = await cli.listNetworks($)
        if (nets.length === 0) return "No networks found."
        return nets
          .map((n) => {
            const parts = [n.id]
            if (n.name) parts.push(n.name)
            return parts.join("  ")
          })
          .join("\n")
      },
    }),

    sandbox_network_show: tool({
      description:
        "Show detailed information about a specific network including its attached sandboxes.",
      args: {
        name: tool.schema
          .string()
          .describe("Network name or ID to inspect"),
      },
      async execute(args) {
        const net = await cli.getNetwork($, args.name)
        return JSON.stringify(net, null, 2)
      },
    }),

    sandbox_network_attach: tool({
      description:
        "Attach the currently active sandbox to a private network, allowing it to communicate with other sandboxes on the same network.",
      args: {
        name: tool.schema
          .string()
          .describe("Network name or ID to attach to"),
      },
      async execute(args) {
        const active = requireSandbox(getActive)
        await cli.attachNetwork($, active.sandboxId, args.name)
        return `Sandbox ${active.sandboxId} attached to network ${args.name}.`
      },
    }),

    sandbox_network_detach: tool({
      description:
        "Detach the currently active sandbox from a private network.",
      args: {
        name: tool.schema
          .string()
          .describe("Network name or ID to detach from"),
      },
      async execute(args) {
        const active = requireSandbox(getActive)
        await cli.detachNetwork($, active.sandboxId, args.name)
        return `Sandbox ${active.sandboxId} detached from network ${args.name}.`
      },
    }),

    sandbox_network_delete: tool({
      description:
        "Delete a private network. All sandboxes must be detached first.",
      args: {
        name: tool.schema
          .string()
          .describe("Network name or ID to delete"),
      },
      async execute(args) {
        await cli.deleteNetwork($, args.name)
        return `Network ${args.name} deleted.`
      },
    }),

    // ----- Disks -----

    sandbox_disk_create: tool({
      description:
        "Register an S3-compatible disk that can be mounted into sandboxes. Requires S3 bucket credentials.",
      args: {
        name: tool.schema
          .string()
          .describe("Name for the disk"),
        bucket: tool.schema
          .string()
          .describe("S3 bucket name"),
        endpoint: tool.schema
          .string()
          .describe("S3-compatible endpoint URL"),
        access_key: tool.schema
          .string()
          .describe("S3 access key ID"),
        secret_key: tool.schema
          .string()
          .describe("S3 secret access key"),
        region: tool.schema
          .string()
          .optional()
          .describe("S3 bucket region"),
        path_style: tool.schema
          .boolean()
          .optional()
          .describe("Use path-style S3 addressing instead of virtual-hosted"),
      },
      async execute(args) {
        const disk = await cli.createDisk($, {
          name: args.name,
          bucket: args.bucket,
          endpoint: args.endpoint,
          accessKey: args.access_key,
          secretKey: args.secret_key,
          region: args.region,
          pathStyle: args.path_style,
        })
        return `Disk created.\n  ID:   ${disk.id}\n  Name: ${disk.name ?? args.name}`
      },
    }),

    sandbox_disk_list: tool({
      description: "List all registered disks in the current CreateOS account.",
      args: {},
      async execute() {
        const disks = await cli.listDisks($)
        if (disks.length === 0) return "No disks found."
        return disks
          .map((d) => {
            const parts = [d.id]
            if (d.name) parts.push(d.name)
            return parts.join("  ")
          })
          .join("\n")
      },
    }),

    sandbox_disk_show: tool({
      description:
        "Show detailed information about a specific disk including its S3 configuration.",
      args: {
        name: tool.schema.string().describe("Disk name or ID to inspect"),
      },
      async execute(args) {
        const disk = await cli.getDisk($, args.name)
        return JSON.stringify(disk, null, 2)
      },
    }),

    sandbox_disk_delete: tool({
      description:
        "Delete a registered disk. The disk must be detached from all sandboxes first.",
      args: {
        name: tool.schema.string().describe("Disk name or ID to delete"),
      },
      async execute(args) {
        await cli.deleteDisk($, args.name)
        return `Disk ${args.name} deleted.`
      },
    }),

    sandbox_disk_attach: tool({
      description:
        "Mount a registered disk into a sandbox at a specified path.",
      args: {
        disk_name: tool.schema
          .string()
          .describe("Disk name or ID to mount"),
        mount_path: tool.schema
          .string()
          .describe("Filesystem path inside the sandbox where the disk will be mounted"),
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe(
            "Sandbox ID to mount the disk into. Defaults to the currently active sandbox.",
          ),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId
        await cli.attachDisk($, id, args.disk_name, args.mount_path)
        return `Disk ${args.disk_name} mounted at ${args.mount_path} on sandbox ${id}.`
      },
    }),

    sandbox_disk_detach: tool({
      description:
        "Unmount a disk from a sandbox.",
      args: {
        disk_name: tool.schema
          .string()
          .describe("Disk name or ID to unmount"),
        mount_path: tool.schema
          .string()
          .describe("The mount path to detach from"),
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe(
            "Sandbox ID to unmount from. Defaults to the currently active sandbox.",
          ),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId
        await cli.detachDisk($, id, args.disk_name, args.mount_path)
        return `Disk ${args.disk_name} detached from ${args.mount_path} on sandbox ${id}.`
      },
    }),

    // ----- Devices -----

    sandbox_device_register: tool({
      description:
        "Register the current machine as a device so it can join private networks alongside sandboxes via VPN.",
      args: {
        name: tool.schema
          .string()
          .optional()
          .describe("Human-readable name for the device"),
      },
      async execute(args) {
        // Check if already registered
        const existing = await cli.listDevices($)
        if (existing.length > 0) {
          return `Device already registered: ${existing[0].id}${existing[0].name ? ` (${existing[0].name})` : ""}`
        }
        const output = await cli.registerDevice($, args.name)
        return output || "Device registered."
      },
    }),

    sandbox_device_status: tool({
      description:
        "Check the registration and connection status of the current device.",
      args: {},
      async execute() {
        const devices = await cli.listDevices($)
        if (devices.length === 0) return "No device registered."
        return devices
          .map((d) => {
            const parts = [d.id]
            if (d.name) parts.push(d.name)
            return parts.join("  ")
          })
          .join("\n")
      },
    }),

    sandbox_vpn_up: tool({
      description:
        "Get the command to bring up the VPN tunnel on this device. The VPN must be started manually by the user because it requires elevated privileges.",
      args: {},
      async execute() {
        return [
          "To start the VPN tunnel, run the following command in your terminal:",
          "",
          "  createos sb vpn up",
          "",
          "This requires sudo/admin privileges and must be run interactively.",
        ].join("\n")
      },
    }),

    sandbox_device_attach: tool({
      description:
        "Attach the current device to a private network, enabling VPN connectivity to sandboxes on that network.",
      args: {
        network: tool.schema
          .string()
          .describe("Network name or ID to attach the device to"),
      },
      async execute(args) {
        const devices = await cli.listDevices($)
        if (devices.length === 0) {
          throw new Error(
            "No device registered. Use sandbox_device_register first.",
          )
        }
        const devId = devices[0].id ?? devices[0].device_id!
        await cli.attachDeviceToNetwork($, devId, args.network)
        return `Device attached to network "${args.network}".\nRun \`createos sb vpn up\` to access sandbox IPs directly.`
      },
    }),

    sandbox_device_detach: tool({
      description:
        "Detach the current device from a private network.",
      args: {
        network: tool.schema
          .string()
          .describe("Network name or ID to detach the device from"),
      },
      async execute(args) {
        const devices = await cli.listDevices($)
        if (devices.length === 0) {
          throw new Error(
            "No device registered. Use sandbox_device_register first.",
          )
        }
        const devId = devices[0].id ?? devices[0].device_id!
        await cli.detachDeviceFromNetwork($, devId, args.network)
        return `Device detached from network "${args.network}".`
      },
    }),
  }
}
