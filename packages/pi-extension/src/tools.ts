/**
 * Tool registration — CLI-only edition.
 *
 * Each of Pi's built-in tools is replaced with a sandbox-backed variant.
 * Each CreateOS capability is a focused, single-purpose tool following
 * Pi extension best practices (snake_case, named promptGuidelines).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as cli from "./cli.ts";
import { type FindParams, runRemoteFind } from "./find-tool.ts";
import { type GrepParams, runRemoteGrep } from "./grep-tool.ts";
import { createBashOps, createEditOps, createLsOps, createReadOps, createWriteOps } from "./ops.ts";

export interface ToolSandbox {
  sandboxId: string;
  cwd: string;
}

export function registerTools(pi: ExtensionAPI, getActive: () => ToolSandbox | null): void {
  const localCwd = process.cwd();
  const localBash = createBashTool(localCwd);
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localLs = createLsTool(localCwd);
  const localFind = createFindTool(localCwd);
  const localGrep = createGrepTool(localCwd);

  function requireSandbox(): ToolSandbox | null {
    const active = getActive();
    if (active) return active;
    if (pi.getFlag("createos") === true) {
      throw new Error(
        "CreateOS sandbox is unavailable — the tool was NOT run on your host. Restart Pi.",
      );
    }
    return null;
  }

  function sandboxTool<T extends { execute: (...args: never[]) => unknown }>(
    local: T,
    makeRemote: (s: ToolSandbox) => T,
  ): T {
    return {
      ...local,
      execute: (...args: Parameters<T["execute"]>) => {
        const active = requireSandbox();
        const tool = active ? makeRemote(active) : local;
        return tool.execute(...args);
      },
    } as T;
  }

  // --- Built-in tool replacements (bash, read, write, edit, ls, find, grep) ---

  pi.registerTool(
    sandboxTool(localBash, (s) =>
      createBashTool(s.cwd, { operations: createBashOps(pi, s.sandboxId) }),
    ),
  );
  pi.registerTool(
    sandboxTool(localRead, (s) =>
      createReadTool(s.cwd, { operations: createReadOps(pi, s.sandboxId) }),
    ),
  );
  pi.registerTool(
    sandboxTool(localWrite, (s) =>
      createWriteTool(s.cwd, { operations: createWriteOps(pi, s.sandboxId) }),
    ),
  );
  pi.registerTool(
    sandboxTool(localEdit, (s) =>
      createEditTool(s.cwd, { operations: createEditOps(pi, s.sandboxId) }),
    ),
  );
  pi.registerTool(
    sandboxTool(localLs, (s) => createLsTool(s.cwd, { operations: createLsOps(pi, s.sandboxId) })),
  );

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate) {
      const active = requireSandbox();
      if (active) {
        if (signal?.aborted) throw new Error("aborted");
        return runRemoteFind(pi, active.sandboxId, active.cwd, params as FindParams);
      }
      return localFind.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localGrep,
    async execute(id, params, signal, onUpdate) {
      const active = requireSandbox();
      if (active) {
        if (signal?.aborted) throw new Error("aborted");
        return runRemoteGrep(pi, active.sandboxId, active.cwd, params as GrepParams);
      }
      return localGrep.execute(id, params, signal, onUpdate);
    },
  });

  // --- Sandbox create ---

  pi.registerTool({
    name: "sandbox_create",
    label: "Create Sandbox",
    description:
      "Create an additional sandbox. Use this when the user needs multiple sandboxes — e.g. multi-node clusters, " +
      "separate database servers, microservice setups. The new sandbox can be joined to a network so it can communicate with others.",
    promptSnippet: "Create a new sandbox",
    promptGuidelines: [
      "Use sandbox_create when the user needs additional sandboxes beyond the current one.",
      "Use sandbox_create with networks to connect the new sandbox to existing sandboxes.",
      "After creating, use sandbox_network_attach if the sandbox needs to join an existing network.",
    ],
    parameters: Type.Object({
      shape: Type.Optional(
        Type.String({
          description: "Sandbox size (default: s-2vcpu-2gb). See sandbox_shapes for options.",
        }),
      ),
      rootfs: Type.Optional(Type.String({ description: "Base image (default: devbox:1)" })),
      name: Type.Optional(Type.String({ description: "Friendly name for the sandbox" })),
      networks: Type.Optional(
        Type.Array(Type.String(), { description: "Network names to join at creation" }),
      ),
    }),
    async execute(_id, { shape, rootfs, name, networks }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const sb = await cli.createSandbox(pi, { shape, rootfs, name, networks, ingress: true });
        const lines = [
          `Sandbox created: ${sb.id}`,
          `IP: ${sb.ip ?? "pending"}`,
          `Shape: ${(sb as any).shape ?? shape ?? "s-2vcpu-2gb"}`,
        ];
        if (sb.ingress_url_template) lines.push(`Ingress: ${sb.ingress_url_template}`);
        if (networks?.length) lines.push(`Networks: ${networks.join(", ")}`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { sandbox: sb } };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox exec (on any sandbox, not just the active one) ---

  pi.registerTool({
    name: "sandbox_exec",
    label: "Exec on Sandbox",
    description:
      "Run a command on a specific sandbox by ID. Use this to execute commands on sandboxes other than the current one — " +
      "e.g. setting up a second node in a cluster, installing software on a database sandbox, etc.",
    promptSnippet: "Run a command on a specific sandbox",
    promptGuidelines: [
      "Use sandbox_exec to run commands on sandboxes created with sandbox_create.",
      "The built-in bash tool runs on the current sandbox. Use sandbox_exec for any other sandbox.",
    ],
    parameters: Type.Object({
      sandbox_id: Type.String({ description: "ID of the target sandbox" }),
      command: Type.String({ description: "Shell command to run" }),
    }),
    async execute(_id, { sandbox_id, command }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const res = await cli.sandboxExec(pi, sandbox_id, command);
        return {
          content: [{ type: "text", text: res.stdout || "(no output)" }],
          details: { exit_code: res.exitCode },
        };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox info ---

  pi.registerTool({
    name: "sandbox_info",
    label: "Sandbox Info",
    description: "Get the current sandbox status, IP, shape, region, and ingress URL.",
    promptSnippet: "Get sandbox details",
    promptGuidelines: [
      "Use sandbox_info to check the current sandbox status, IP address, or ingress URL.",
    ],
    parameters: Type.Object({
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? getActive()?.sandboxId;
      if (!targetId) return txt("No sandbox active.");
      try {
        const info = await cli.getSandbox(pi, targetId);
        const lines = [
          `ID: ${info.id}`,
          `Status: ${info.status}`,
          `Name: ${info.name ?? "n/a"}`,
          `IP: ${info.ip ?? "n/a"}`,
          `Shape: ${(info as any).shape ?? "n/a"}`,
          `Region: ${info.region ?? "n/a"}`,
        ];
        if (info.ingress_url_template) lines.push(`Ingress: ${info.ingress_url_template}`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { sandbox: info } };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox list ---

  pi.registerTool({
    name: "sandbox_list",
    label: "List Sandboxes",
    description: "List all sandboxes owned by the user.",
    promptSnippet: "List all sandboxes",
    promptGuidelines: [
      "Use sandbox_list to see all sandboxes the user owns, including paused and running ones.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const sbs = await cli.listSandboxes(pi);
        if (sbs.length === 0) return txt("No sandboxes found.");
        const lines = sbs.map(
          (s) => `${s.id} · ${s.status} · ${s.name ?? ""}${s.ip ? ` · ${s.ip}` : ""}`,
        );
        return { content: [{ type: "text", text: lines.join("\n") }], details: { sandboxes: sbs } };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox pause ---

  pi.registerTool({
    name: "sandbox_pause",
    label: "Pause Sandbox",
    description:
      "Pause the sandbox, saving its state. The sandbox becomes unavailable until resumed.",
    promptSnippet: "Pause a sandbox",
    promptGuidelines: [
      "Use sandbox_pause to snapshot and pause a sandbox. WARNING: this disconnects the current session if pausing the active sandbox.",
    ],
    parameters: Type.Object({
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? getActive()?.sandboxId;
      if (!targetId) return txt("No sandbox to pause.");
      try {
        await cli.pauseSandbox(pi, targetId);
        return {
          ...txt(`Sandbox ${targetId} is pausing. It will be unavailable until resumed.`),
          terminate: true,
        };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox resume ---

  pi.registerTool({
    name: "sandbox_resume",
    label: "Resume Sandbox",
    description: "Resume a paused sandbox.",
    promptSnippet: "Resume a paused sandbox",
    promptGuidelines: ["Use sandbox_resume to bring a paused sandbox back to running state."],
    parameters: Type.Object({
      sandbox_id: Type.String({ description: "ID of the paused sandbox to resume" }),
    }),
    async execute(_id, { sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        await cli.resumeSandbox(pi, sandbox_id);
        return txt(`Sandbox ${sandbox_id} is resuming.`);
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox fork ---

  pi.registerTool({
    name: "sandbox_fork",
    label: "Fork Sandbox",
    description: "Clone a paused sandbox into a brand-new sandbox with the same state.",
    promptSnippet: "Fork a sandbox",
    promptGuidelines: [
      "Use sandbox_fork to create a copy of a sandbox. The source sandbox must be paused first.",
    ],
    parameters: Type.Object({
      sandbox_id: Type.Optional(
        Type.String({ description: "Sandbox ID to fork (defaults to current)" }),
      ),
      paused: Type.Optional(
        Type.Boolean({ description: "Keep the fork paused instead of auto-resuming" }),
      ),
    }),
    async execute(_id, { sandbox_id, paused }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? getActive()?.sandboxId;
      if (!targetId) return txt("No sandbox to fork.");
      try {
        const forked = await cli.forkSandbox(pi, targetId, { paused });
        return {
          content: [
            {
              type: "text",
              text: `Forked into ${forked.id} (${forked.status}). IP: ${forked.ip ?? "pending"}`,
            },
          ],
          details: { sandbox: forked },
        };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox destroy ---

  pi.registerTool({
    name: "sandbox_destroy",
    label: "Destroy Sandbox",
    description: "Permanently delete a sandbox. This cannot be undone.",
    promptSnippet: "Destroy a sandbox",
    promptGuidelines: [
      "Use sandbox_destroy to permanently delete a sandbox. Requires an explicit sandbox_id.",
    ],
    parameters: Type.Object({
      sandbox_id: Type.String({ description: "ID of the sandbox to destroy" }),
    }),
    async execute(_id, { sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        await cli.destroySandbox(pi, sandbox_id);
        return { ...txt(`Sandbox ${sandbox_id} destroyed.`), terminate: true };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox ingress toggle ---

  pi.registerTool({
    name: "sandbox_ingress",
    label: "Toggle Ingress",
    description: "Enable or disable public HTTPS URL access for a sandbox.",
    promptSnippet: "Toggle public URL on/off",
    promptGuidelines: [
      "Use sandbox_ingress to enable or disable the public HTTPS URL for a sandbox.",
    ],
    parameters: Type.Object({
      enabled: Type.Boolean({ description: "true to enable, false to disable" }),
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { enabled, sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? getActive()?.sandboxId;
      if (!targetId) return txt("No sandbox active.");
      try {
        await cli.editSandbox(pi, targetId, { ingress: enabled });
        if (enabled) {
          const info = await cli.getSandbox(pi, targetId);
          return txt(
            `Ingress enabled.${info.ingress_url_template ? ` URL: ${info.ingress_url_template}` : ""}`,
          );
        }
        return txt("Ingress disabled.");
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox firewall ---

  pi.registerTool({
    name: "sandbox_firewall",
    label: "Set Firewall",
    description:
      "Set egress firewall rules for a sandbox. Pass an empty list to allow all outbound traffic.",
    promptSnippet: "Set sandbox egress rules",
    promptGuidelines: [
      "Use sandbox_firewall to restrict which domains/IPs the sandbox can reach. Empty rules = allow all.",
    ],
    parameters: Type.Object({
      rules: Type.Array(Type.String(), {
        description:
          'Allowed domains or IPs (e.g. ["pypi.org", "1.1.1.1:53"]). Empty array = allow all.',
      }),
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { rules, sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? getActive()?.sandboxId;
      if (!targetId) return txt("No sandbox active.");
      try {
        await cli.editSandbox(pi, targetId, { egress: rules });
        return txt(
          rules.length > 0
            ? `Firewall set: ${rules.join(", ")}`
            : "Firewall cleared — all outbound allowed.",
        );
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox bandwidth ---

  pi.registerTool({
    name: "sandbox_bandwidth",
    label: "Check Bandwidth",
    description: "Check bandwidth usage and quota for a sandbox.",
    promptSnippet: "Check bandwidth usage",
    promptGuidelines: [
      "Use sandbox_bandwidth to check how much bandwidth the sandbox has used and whether it is capped.",
    ],
    parameters: Type.Object({
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? getActive()?.sandboxId;
      if (!targetId) return txt("No sandbox active.");
      try {
        const bw = await cli.getBandwidth(pi, targetId);
        return txt(
          `Bandwidth: ${fmtBytes(bw.used_bytes)} used of ${fmtBytes(bw.quota_bytes)} (${fmtBytes(bw.remaining_bytes)} remaining)${bw.capped ? " — CAPPED" : ""}`,
        );
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox shapes ---

  pi.registerTool({
    name: "sandbox_shapes",
    label: "List Shapes",
    description: "List available sandbox sizes (vCPU, RAM).",
    promptSnippet: "List available sandbox sizes",
    promptGuidelines: [
      "Use sandbox_shapes to see what sandbox sizes are available before creating a new sandbox.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const shapes = await cli.listShapes(pi);
        const lines = shapes.map(
          (s: any) => `${s.name ?? s.id} · ${s.vcpu} vCPU · ${s.mem_mib} MB RAM`,
        );
        return { content: [{ type: "text", text: lines.join("\n") }], details: { shapes } };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox images ---

  pi.registerTool({
    name: "sandbox_images",
    label: "List Images",
    description: "List available base images (rootfs) for sandbox creation.",
    promptSnippet: "List available sandbox base images",
    promptGuidelines: [
      "Use sandbox_images to see what base images are available before creating a new sandbox.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const rootfs = await cli.listRootfs(pi);
        return {
          content: [{ type: "text", text: JSON.stringify(rootfs, null, 2) }],
          details: { rootfs },
        };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Preview URL ---

  pi.registerTool({
    name: "sandbox_preview_url",
    label: "Preview URL",
    description: "Get the public HTTPS URL for a port served inside the sandbox.",
    promptSnippet: "Get a public URL for a sandbox port",
    promptGuidelines: [
      "Use sandbox_preview_url after starting a server to give the user a clickable public link.",
    ],
    parameters: Type.Object({
      port: Type.Integer({
        minimum: 1,
        maximum: 65535,
        description: "The port the server listens on",
      }),
    }),
    async execute(_id, { port }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const active = requireSandbox();
      if (!active) return txt("No active sandbox.");
      try {
        const info = await cli.getSandbox(pi, active.sandboxId);
        if (info.ingress_url_template) {
          return txt(
            `Preview URL for port ${port}: ${info.ingress_url_template.replace("<port>", String(port))}`,
          );
        }
        return txt("Ingress not enabled. Use sandbox_ingress to enable it first.");
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Tunnel (port forward) ---

  pi.registerTool({
    name: "sandbox_tunnel",
    label: "Port Forward",
    description: "Forward a sandbox port to localhost on the user's machine. No setup needed.",
    promptSnippet: "Forward a sandbox port to localhost",
    promptGuidelines: [
      "Use sandbox_tunnel when the user wants to access a sandbox port from their machine.",
      "Prefer sandbox_tunnel over sandbox_device_attach — sandbox_tunnel requires no setup.",
    ],
    parameters: Type.Object({
      remote_port: Type.Integer({
        minimum: 1,
        maximum: 65535,
        description: "Port inside the sandbox",
      }),
      local_port: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 65535,
          description: "Local port (defaults to remote_port)",
        }),
      ),
    }),
    async execute(_id, { remote_port, local_port }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const active = requireSandbox();
      if (!active) return txt("No active sandbox.");
      try {
        const result = await cli.startTunnel(pi, active.sandboxId, remote_port, local_port);
        return txt(
          `Port forward started: localhost:${result.localPort} → sandbox:${remote_port}\nAccess at: http://localhost:${result.localPort}`,
        );
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sync (directory mount) ---

  pi.registerTool({
    name: "sandbox_sync",
    label: "Sync Directory",
    description:
      "Mount, sync, or mirror a local directory from the user's machine into the sandbox. " +
      "Bidirectional by default — changes on either side propagate to the other. Runs in the background until the session ends.",
    promptSnippet: "Mount/sync a local directory into the sandbox",
    promptGuidelines: [
      'Use sandbox_sync when the user says "mount", "sync", "mirror", or "upload directory" into the sandbox.',
      'Use sandbox_sync with mode "one-way" if only local changes should push to the sandbox.',
      'Use sandbox_sync with mode "mirror" to make the sandbox directory identical to the local one.',
    ],
    parameters: Type.Object({
      local_dir: Type.String({
        description: "Absolute path to the local directory on the user's machine",
      }),
      remote_dir: Type.String({
        description: "Absolute path inside the sandbox (e.g. /root/project)",
      }),
      mode: Type.Optional(
        Type.String({
          description:
            'Sync mode: "two-way" (default), "one-way" (local wins), or "mirror" (local wins + deletes extras)',
        }),
      ),
      exclude: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Glob patterns to exclude (e.g. ["node_modules", "*.log"])',
        }),
      ),
    }),
    async execute(_id, { local_dir, remote_dir, mode, exclude }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const active = requireSandbox();
      if (!active) return txt("No active sandbox.");
      try {
        const result = await cli.startSync(pi, active.sandboxId, local_dir, remote_dir, {
          mode,
          exclude,
        });
        return txt(
          `Sync started: ${local_dir} ↔ sandbox:${remote_dir}${mode ? ` (${mode})` : ""}\nChanges will propagate automatically. PID: ${result.pid}`,
        );
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Network tools ---

  pi.registerTool({
    name: "sandbox_network_create",
    label: "Create Network",
    description: "Create a new private network for sandbox-to-sandbox communication.",
    promptSnippet: "Create a private network",
    promptGuidelines: [
      "Use sandbox_network_create when sandboxes need to communicate with each other.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Network name" }),
    }),
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const net = await cli.createNetwork(pi, name);
        return {
          content: [{ type: "text", text: `Network created: ${net.name} (${net.id})` }],
          details: { network: net },
        };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_network_list",
    label: "List Networks",
    description: "List all private networks owned by the user.",
    promptSnippet: "List private networks",
    promptGuidelines: [
      "Use sandbox_network_list to see existing networks before creating or attaching.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const nets = await cli.listNetworks(pi);
        if (nets.length === 0) return txt("No networks found.");
        const lines = nets.map((n) => `${n.name} (${n.id}) · ${n.member_count ?? 0} members`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { networks: nets } };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_network_show",
    label: "Show Network",
    description: "Show network details including member sandbox IPs.",
    promptSnippet: "Show network members and their IPs",
    promptGuidelines: [
      "Use sandbox_network_show to see which sandboxes are on a network and their IPs for configuring connections.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Network name or id" }),
    }),
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const net = await cli.getNetwork(pi, name);
        const lines = [`Network: ${net.name} (${net.id})`];
        if (net.members?.length) {
          lines.push("Members:");
          for (const m of net.members)
            lines.push(`  ${m.sandbox_id} · ${m.status} · ${m.ip}${m.name ? ` · ${m.name}` : ""}`);
        } else lines.push("No members");
        return { content: [{ type: "text", text: lines.join("\n") }], details: { network: net } };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_network_attach",
    label: "Attach to Network",
    description: "Attach the current sandbox to a private network.",
    promptSnippet: "Join a sandbox to a network",
    promptGuidelines: [
      "Use sandbox_network_attach to join the current sandbox to a network so it can reach other members.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Network name or id" }),
    }),
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const active = requireSandbox();
      if (!active) return txt("No active sandbox.");
      try {
        await cli.attachNetwork(pi, active.sandboxId, name);
        return txt(`Attached sandbox to network "${name}".`);
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_network_detach",
    label: "Detach from Network",
    description: "Detach the current sandbox from a private network.",
    promptSnippet: "Remove a sandbox from a network",
    promptGuidelines: ["Use sandbox_network_detach to remove the current sandbox from a network."],
    parameters: Type.Object({
      name: Type.String({ description: "Network name or id" }),
    }),
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const active = requireSandbox();
      if (!active) return txt("No active sandbox.");
      try {
        await cli.detachNetwork(pi, active.sandboxId, name);
        return txt(`Detached sandbox from network "${name}".`);
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_network_delete",
    label: "Delete Network",
    description: "Delete a private network. The network must have no members.",
    promptSnippet: "Delete a network",
    promptGuidelines: [
      "Use sandbox_network_delete to remove a network. Detach all sandboxes first.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Network name or id" }),
    }),
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        await cli.deleteNetwork(pi, name);
        return txt(`Network "${name}" deleted.`);
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Disk tools ---

  pi.registerTool({
    name: "sandbox_disk_create",
    label: "Create Disk",
    description:
      "Register an S3-compatible bucket as a persistent disk that can be mounted into sandboxes.",
    promptSnippet: "Register an S3 bucket as a mountable disk",
    promptGuidelines: [
      "Use sandbox_disk_create when the user wants persistent storage that survives sandbox destroy.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Disk name" }),
      bucket: Type.String({ description: "S3 bucket name" }),
      endpoint: Type.String({ description: "S3 endpoint URL (e.g. https://s3.amazonaws.com)" }),
      access_key: Type.String({ description: "Access key ID" }),
      secret_key: Type.String({ description: "Secret access key" }),
      region: Type.Optional(Type.String({ description: "AWS region (e.g. us-east-1)" })),
      path_style: Type.Optional(
        Type.Boolean({ description: "Use path-style URLs (needed for MinIO)" }),
      ),
    }),
    async execute(
      _id,
      { name, bucket, endpoint, access_key, secret_key, region, path_style },
      signal,
    ) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const disk = await cli.createDisk(pi, {
          name,
          bucket,
          endpoint,
          accessKey: access_key,
          secretKey: secret_key,
          region,
          pathStyle: path_style,
        });
        return {
          content: [{ type: "text", text: `Disk created: ${disk.name} (${disk.id})` }],
          details: { disk },
        };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_disk_list",
    label: "List Disks",
    description: "List all S3 disks registered by the user.",
    promptSnippet: "List registered disks",
    promptGuidelines: [
      "Use sandbox_disk_list to see available disks before attaching one to a sandbox.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const disks = await cli.listDisks(pi);
        if (disks.length === 0) return txt("No disks registered.");
        const lines = disks.map(
          (d) => `${d.name} (${d.id})${d.config?.bucket ? ` · bucket: ${d.config.bucket}` : ""}`,
        );
        return { content: [{ type: "text", text: lines.join("\n") }], details: { disks } };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_disk_show",
    label: "Show Disk",
    description: "Show details for a registered disk.",
    promptSnippet: "Show disk details",
    promptGuidelines: [
      "Use sandbox_disk_show to see a disk's configuration and which sandboxes it is attached to.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Disk name or id" }),
    }),
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const disk = await cli.getDisk(pi, name);
        return {
          content: [{ type: "text", text: JSON.stringify(disk, null, 2) }],
          details: { disk },
        };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_disk_delete",
    label: "Delete Disk",
    description: "Delete a registered disk. The disk must not be attached to any sandbox.",
    promptSnippet: "Delete a disk",
    promptGuidelines: [
      "Use sandbox_disk_delete to remove a disk registration. Detach it from all sandboxes first.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Disk name or id" }),
    }),
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        await cli.deleteDisk(pi, name);
        return txt(`Disk "${name}" deleted.`);
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_disk_attach",
    label: "Attach Disk",
    description: "Mount a registered disk into a running sandbox at a given path.",
    promptSnippet: "Mount a disk into a sandbox",
    promptGuidelines: [
      "Use sandbox_disk_attach to mount persistent storage into a sandbox. The mount path must be absolute (e.g. /mnt/data).",
    ],
    parameters: Type.Object({
      disk_name: Type.String({ description: "Disk name or id" }),
      mount_path: Type.String({
        description: "Absolute mount path inside the sandbox (e.g. /mnt/data)",
      }),
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { disk_name, mount_path, sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? getActive()?.sandboxId;
      if (!targetId) return txt("No sandbox active.");
      try {
        await cli.attachDisk(pi, targetId, disk_name, mount_path);
        return txt(`Disk "${disk_name}" mounted at ${mount_path}`);
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_disk_detach",
    label: "Detach Disk",
    description: "Unmount a disk from a sandbox. The bucket data is untouched.",
    promptSnippet: "Unmount a disk from a sandbox",
    promptGuidelines: [
      "Use sandbox_disk_detach to unmount a disk. The data in the bucket remains.",
    ],
    parameters: Type.Object({
      disk_name: Type.String({ description: "Disk name or id" }),
      mount_path: Type.String({ description: "Mount path to detach" }),
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { disk_name, mount_path, sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? getActive()?.sandboxId;
      if (!targetId) return txt("No sandbox active.");
      try {
        await cli.detachDisk(pi, targetId, disk_name, mount_path);
        return txt(`Disk "${disk_name}" detached from ${mount_path}`);
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Device tools ---

  pi.registerTool({
    name: "sandbox_device_register",
    label: "Register Device",
    description:
      "Register the user's machine as a device so it can access sandbox networks directly. " +
      "This is a one-time operation. Requires wireguard-tools installed on the host.",
    promptSnippet: "Register this machine for direct sandbox access",
    promptGuidelines: [
      "Use sandbox_device_register before sandbox_device_attach or sandbox_vpn_up.",
      "Use sandbox_device_register only if sandbox_device_status shows no device registered.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Device name (defaults to hostname)" })),
    }),
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const devices = await cli.listDevices(pi);
        if (devices.length > 0) {
          return txt(
            `Device already registered: ${devices[0].name} (${devices[0].client_ip ?? "n/a"})`,
          );
        }
        const output = await cli.registerDevice(pi, name);
        return txt(output || "Device registered.");
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_device_status",
    label: "Device Status",
    description: "Check if the user has a registered device for direct sandbox access.",
    promptSnippet: "Check device registration status",
    promptGuidelines: [
      "Use sandbox_device_status to check if the user has a device registered before using sandbox_device_attach or sandbox_vpn_up.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const devices = await cli.listDevices(pi);
        if (devices.length === 0) {
          return txt("No device registered. Use sandbox_device_register to register this machine.");
        }
        const lines = devices.map(
          (d) => `${d.name} · ${d.id ?? d.device_id} · IP: ${d.client_ip ?? "n/a"}`,
        );
        return {
          content: [{ type: "text", text: `Registered devices:\n${lines.join("\n")}` }],
          details: { devices },
        };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_vpn_up",
    label: "Start VPN",
    description:
      "Tell the user to start the VPN tunnel. This command requires sudo and must be run by the user in a separate terminal. " +
      "Returns the exact command the user should run.",
    promptSnippet: "Get the VPN start command for the user to run",
    promptGuidelines: [
      "Use sandbox_vpn_up after sandbox_device_register and sandbox_device_attach.",
      "sandbox_vpn_up does NOT start the VPN — it tells the user the command to run in another terminal.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const devices = await cli.listDevices(pi);
        if (devices.length === 0) {
          return txt("No device registered. Use sandbox_device_register first.");
        }
        return txt(
          "The user needs to run this command in a separate terminal (it requires sudo):\n\n  createos sb vpn up\n\nOnce connected, sandbox IPs are reachable directly.",
        );
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_device_attach",
    label: "Attach Device to Network",
    description: "Attach the user's device to a network so they can access sandbox IPs directly.",
    promptSnippet: "Give user's machine direct access to a network",
    promptGuidelines: [
      "Use sandbox_device_attach to give the user direct IP access. After attaching, tell them to run `createos sb vpn up`.",
    ],
    parameters: Type.Object({
      network: Type.String({ description: "Network name or id" }),
    }),
    async execute(_id, { network }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const devices = await cli.listDevices(pi);
        if (devices.length === 0)
          return txt("No device registered. Run: createos sb devices register");
        const devId = devices[0].id ?? devices[0].device_id!;
        await cli.attachDeviceToNetwork(pi, devId, network);
        return txt(
          `Device attached to network "${network}".\nRun \`createos sb vpn up\` to access sandbox IPs directly.`,
        );
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_device_detach",
    label: "Detach Device from Network",
    description: "Remove the user's device from a network.",
    promptSnippet: "Remove device access to a network",
    promptGuidelines: [
      "Use sandbox_device_detach to revoke the user's direct access to a network.",
    ],
    parameters: Type.Object({
      network: Type.String({ description: "Network name or id" }),
    }),
    async execute(_id, { network }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const devices = await cli.listDevices(pi);
        if (devices.length === 0) return txt("No device registered.");
        const devId = devices[0].id ?? devices[0].device_id!;
        await cli.detachDeviceFromNetwork(pi, devId, network);
        return txt(`Device detached from network "${network}".`);
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- User bash routing ---

  pi.on("user_bash", () => {
    const active = getActive();
    if (active) return { operations: createBashOps(pi, active.sandboxId, active.cwd) };
    if (pi.getFlag("createos") === true) {
      return {
        result: {
          output:
            "CreateOS sandbox is unavailable — the command was NOT run on your host. Restart Pi.",
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
    return;
  });
}

// --- Helpers ---

function txt(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function errmsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fmtBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
