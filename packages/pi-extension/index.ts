/**
 * pi-createos — run Pi's tools inside a remote, ephemeral CreateOS Sandbox.
 *
 * CLI-only: every operation goes through `createos` CLI. No HTTP client,
 * no API key env vars — just `createos login` and go.
 */

import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import * as cli from "./src/cli.ts";
import { sandboxExec, cleanupTempKey, autoInstallCLI } from "./src/cli.ts";
import {
  selectStartupSync,
  startProjectWatch,
  stopProjectWatch,
  syncProjectOnce,
  type ProjectWatch,
} from "./src/startup-sync.ts";
import { registerTools } from "./src/tools.ts";
import { shortId } from "./src/util.ts";

const SESSION_ENTRY = "createos-session";

interface SessionEntryData {
  sandboxId: string;
  cwd: string;
}
interface ActiveSandbox {
  sandboxId: string;
  cwd: string;
}

/** The user's local working directory (where they launched Pi from). */
const hostCwd = process.cwd();

export default function (pi: ExtensionAPI) {
  pi.registerFlag("createos", {
    description: "Run tools inside a CreateOS sandbox",
    type: "boolean",
  });
  pi.registerFlag("shape", { description: "Sandbox shape (default: s-2vcpu-2gb)", type: "string" });
  pi.registerFlag("rootfs", { description: "CreateOS rootfs or template to use", type: "string" });
  pi.registerFlag("network", {
    description: "Network(s) to join (comma-separated)",
    type: "string",
  });
  pi.registerFlag("sync-once", {
    description: "Copy the host project to /root/workspace before starting Pi",
    type: "boolean",
  });
  pi.registerFlag("watch", {
    description: "Keep the host project and /root/workspace synchronized",
    type: "boolean",
  });

  let active: ActiveSandbox | null = null;
  let projectWatch: ProjectWatch | undefined;

  registerTools(pi, () => (active ? { sandboxId: active.sandboxId, cwd: active.cwd } : null));

  async function setupStartupSync(
    ctx: ExtensionContext,
    mode: "once" | "watch" | undefined,
    sandbox: ActiveSandbox,
  ): Promise<void> {
    if (!mode) {
      setRunningStatus(ctx, sandbox.sandboxId, sandbox.cwd);
      return;
    }
    if (mode === "once") {
      await runStartupLoader(ctx, "Syncing project to sandbox…", async (signal) => {
        await syncProjectOnce(pi, sandbox.sandboxId, hostCwd, signal);
        return true;
      });
      setRunningStatus(ctx, sandbox.sandboxId, sandbox.cwd);
      return;
    }

    const watch = await runStartupLoader(ctx, "Starting project file watch…", (signal) =>
      startProjectWatch(pi, sandbox.sandboxId, hostCwd, signal),
    );
    projectWatch = watch;
    setWatchingStatus(ctx, sandbox.sandboxId, sandbox.cwd);
  }

  // --- Commands ---

  pi.registerCommand("sandbox", {
    description: "Show the active CreateOS sandbox's status",
    handler: async (_args, ctx) => {
      if (!active) {
        ctx.ui.notify("No CreateOS sandbox is active. Launch Pi with --createos.", "warning");
        return;
      }
      try {
        const info = await cli.getSandbox(pi, active.sandboxId);
        const lines = [`☁ ${shortId(active.sandboxId)} · ${info.status}`, `cwd: ${active.cwd}`];
        if (info.ingress_url_template) lines.push(`ingress: ${info.ingress_url_template}`);
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err) {
        ctx.ui.notify(`Failed: ${errorMessage(err)}`, "error");
      }
    },
  });

  pi.registerCommand("network", {
    description: "Manage CreateOS networks: create, ls, show, rm, attach, detach",
    getArgumentCompletions() {
      return [
        { value: "create", label: "Create a new network" },
        { value: "ls", label: "List your networks" },
        { value: "show", label: "Show network details" },
        { value: "rm", label: "Delete a network" },
        { value: "attach", label: "Attach this sandbox to a network" },
        { value: "detach", label: "Detach this sandbox from a network" },
      ];
    },
    handler: async (args, ctx) => {
      if (!active) {
        ctx.ui.notify("No sandbox active. Launch with --createos.", "warning");
        return;
      }
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0],
        arg = parts.slice(1).join(" ").trim();
      try {
        switch (sub) {
          case "create": {
            if (!arg) {
              ctx.ui.notify("Usage: /network create <name>", "warning");
              return;
            }
            const net = await cli.createNetwork(pi, arg);
            ctx.ui.notify(`Network created: ${net.name} (${net.id})`, "info");
            break;
          }
          case "ls":
          case "list": {
            const nets = await cli.listNetworks(pi);
            if (!nets.length) {
              ctx.ui.notify("No networks. Create with /network create <name>", "info");
              return;
            }
            ctx.ui.notify(
              `Networks:\n${nets.map((n) => `  ${n.name} (${n.id}) · ${n.member_count ?? 0} members`).join("\n")}`,
              "info",
            );
            break;
          }
          case "show": {
            if (!arg) {
              ctx.ui.notify("Usage: /network show <name|id>", "warning");
              return;
            }
            const detail = await cli.getNetwork(pi, arg);
            const lines = [`Network: ${detail.name} (${detail.id})`];
            if (detail.members?.length) {
              lines.push("Members:");
              for (const m of detail.members)
                lines.push(
                  `  ${m.sandbox_id} · ${m.status} · ${m.ip}${m.name ? ` · ${m.name}` : ""}`,
                );
            } else lines.push("No members");
            ctx.ui.notify(lines.join("\n"), "info");
            break;
          }
          case "rm":
          case "delete":
            if (!arg) {
              ctx.ui.notify("Usage: /network rm <name|id>", "warning");
              return;
            }
            if (!(await ctx.ui.confirm("Delete network", `Delete "${arg}"?`))) return;
            await cli.deleteNetwork(pi, arg);
            ctx.ui.notify(`Network "${arg}" deleted`, "info");
            break;
          case "attach":
            if (!arg) {
              ctx.ui.notify("Usage: /network attach <name|id>", "warning");
              return;
            }
            await cli.attachNetwork(pi, active.sandboxId, arg);
            ctx.ui.notify(`Attached sandbox to network "${arg}"`, "info");
            break;
          case "detach":
            if (!arg) {
              ctx.ui.notify("Usage: /network detach <name|id>", "warning");
              return;
            }
            await cli.detachNetwork(pi, active.sandboxId, arg);
            ctx.ui.notify(`Detached sandbox from network "${arg}"`, "info");
            break;
          default:
            ctx.ui.notify("/network <create|ls|show|rm|attach|detach> [args]", "info");
        }
      } catch (err) {
        ctx.ui.notify(`Network error: ${errorMessage(err)}`, "error");
      }
    },
  });

  pi.registerCommand("device", {
    description: "Show device status and attach/detach to networks",
    getArgumentCompletions() {
      return [
        { value: "status", label: "Show registered devices" },
        { value: "attach", label: "Attach device to a network" },
        { value: "detach", label: "Detach device from a network" },
      ];
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0] || "status",
        arg = parts.slice(1).join(" ").trim();
      try {
        switch (sub) {
          case "status": {
            const devs = await cli.listDevices(pi);
            if (!devs.length) {
              ctx.ui.notify(
                "No device registered.\n\n  createos sb devices register   # one-time\n  createos sb vpn up              # connect",
                "info",
              );
              return;
            }
            const lines = devs.map(
              (d) => `  ${d.name} · ${d.id ?? d.device_id} · IP: ${d.client_ip ?? "n/a"}`,
            );
            ctx.ui.notify(
              `Devices:\n${lines.join("\n")}\n\nRun \`createos sb vpn up\` to connect.`,
              "info",
            );
            break;
          }
          case "attach": {
            if (!arg) {
              ctx.ui.notify("Usage: /device attach <network>", "warning");
              return;
            }
            const devs = await cli.listDevices(pi);
            if (!devs.length) {
              ctx.ui.notify("No device. Run: createos sb devices register", "warning");
              return;
            }
            await cli.attachDeviceToNetwork(pi, devs[0].id ?? devs[0].device_id!, arg);
            ctx.ui.notify(
              `Device attached to "${arg}". Run \`createos sb vpn up\` to connect.`,
              "info",
            );
            break;
          }
          case "detach": {
            if (!arg) {
              ctx.ui.notify("Usage: /device detach <network>", "warning");
              return;
            }
            const devs = await cli.listDevices(pi);
            if (!devs.length) {
              ctx.ui.notify("No device registered.", "warning");
              return;
            }
            await cli.detachDeviceFromNetwork(pi, devs[0].id ?? devs[0].device_id!, arg);
            ctx.ui.notify(`Device detached from "${arg}".`, "info");
            break;
          }
          default:
            ctx.ui.notify("/device <status|attach|detach> [network]", "info");
        }
      } catch (err) {
        ctx.ui.notify(`Device error: ${errorMessage(err)}`, "error");
      }
    },
  });

  // --- Lifecycle ---

  pi.on("session_start", async (event, ctx) => {
    if (pi.getFlag("createos") !== true) return;
    if (active) return;

    let startupSync: "once" | "watch" | undefined;
    try {
      startupSync = selectStartupSync(
        pi.getFlag("sync-once") === true,
        pi.getFlag("watch") === true,
      );
    } catch (err) {
      ctx.ui.notify(errorMessage(err), "error");
      return;
    }

    if (!(await cli.isCreateOSInstalled(pi))) {
      setStatus(ctx, "☁ createos · installing CLI…");
      ctx.ui.notify("CreateOS CLI not found — installing automatically…", "info");
      if (!(await autoInstallCLI(pi))) {
        ctx.ui.notify(
          "Failed to auto-install CreateOS CLI. Install manually: curl -sfL https://raw.githubusercontent.com/NodeOps-app/createos-cli/main/install.sh | sh",
          "error",
        );
        setStatus(ctx, undefined);
        return;
      }
      ctx.ui.notify("CreateOS CLI installed successfully.", "info");
    }
    if (!(await cli.isLoggedIn(pi))) {
      ctx.ui.notify("Not logged in. Run: createos login", "error");
      return;
    }

    const persisted = ctx.sessionManager.getSessionFile() !== undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    setStatus(ctx, "☁ createos · spinning up sandbox…");
    const startedAt = Date.now();
    let createdId: string | undefined;

    try {
      // Reattach on resume/reload.
      if (persisted && event.reason !== "fork") {
        const prev = latestSessionEntry(ctx);
        if (prev) {
          try {
            setStatus(ctx, "☁ createos · resuming sandbox…");
            const info = await cli.getSandbox(pi, prev.sandboxId);
            if (info.status === "paused") {
              await cli.resumeSandbox(pi, prev.sandboxId);
              let retries = 30;
              while (retries-- > 0) {
                const check = await cli.getSandbox(pi, prev.sandboxId);
                if (check.status === "running") break;
                await new Promise((r) => setTimeout(r, 1000));
              }
            }
            active = { sandboxId: prev.sandboxId, cwd: prev.cwd };
            await setupStartupSync(ctx, startupSync, active);
            ctx.ui.notify(`Reattached · ${shortId(prev.sandboxId)}`, "info");
            return;
          } catch (err) {
            if (!(err instanceof cli.CLIError && err.isNotFound)) throw err;
          }
        }
      }

      const shape = stringFlag(pi.getFlag("shape")) ?? "s-2vcpu-2gb";
      const rootfs = stringFlag(pi.getFlag("rootfs"));
      const networkFlag = stringFlag(pi.getFlag("network"));
      const networks = networkFlag
        ? networkFlag
            .split(",")
            .map((n) => n.trim())
            .filter(Boolean)
        : undefined;

      const sandbox = await cli.createSandbox(pi, {
        shape,
        rootfs,
        ingress: true,
        networks,
        name: `pi-${shortId(sessionId)}`,
      });
      createdId = sandbox.id;

      // Create returns after the sandbox is running — no polling needed.
      const cwd = "/root/workspace";
      await sandboxExec(pi, sandbox.id, `mkdir -p ${cwd}`);

      active = { sandboxId: sandbox.id, cwd };
      if (persisted)
        pi.appendEntry(SESSION_ENTRY, { sandboxId: sandbox.id, cwd } as SessionEntryData);

      await setupStartupSync(ctx, startupSync, active);
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      ctx.ui.notify(`Sandbox ready · ${shortId(sandbox.id)} · ${secs}s`, "info");
    } catch (err) {
      active = null;
      if (createdId)
        try {
          await cli.destroySandbox(pi, createdId);
        } catch (cleanupError) {
          console.error("CreateOS: failed to clean up sandbox", cleanupError);
        }
      setStatus(ctx, undefined);
      ctx.ui.notify(`CreateOS: failed — ${errorMessage(err)}`, "error");
    }
  });

  pi.on("before_agent_start", (event) => {
    if (!active) return;
    const cwdLine = `Current working directory: ${active.cwd} (CreateOS sandbox ${shortId(active.sandboxId)})`;
    let systemPrompt = event.systemPrompt.replace(/Current working directory: .*/g, cwdLine);
    // Caveman-style: short, declarative, environment-aware.
    // The model already sees tool descriptions/guidelines — don't repeat them here.
    systemPrompt +=
      "\n\n--- CreateOS Sandbox Environment ---" +
      `\nSandbox: ${active.sandboxId}` +
      `\nCwd: ${active.cwd}` +
      `\nHost dir: ${hostCwd}` +
      "\nAll tools run remotely in this sandbox. You know the sandbox ID and cwd — never run pwd/hostname." +
      "\n" +
      "\nQuick rules:" +
      `\n- "mount/sync this dir" → sandbox_sync local_dir="${hostCwd}" remote_dir="/root/workspace"` +
      "\n- Port access → sandbox_preview_url (public URL) > sandbox_tunnel (localhost) > device VPN (last resort)" +
      "\n- Multi-node → sandbox_network_create + sandbox_create with network + sandbox_exec on other sandboxes" +
      "\n--- End CreateOS ---";
    return { systemPrompt };
  });

  pi.on("session_shutdown", async (event, _ctx) => {
    if (projectWatch) {
      try {
        await stopProjectWatch(pi, projectWatch);
      } catch (stopError) {
        console.error("CreateOS: failed to stop project watch", stopError);
      }
      projectWatch = undefined;
    }
    if (!active) return;
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") return;
    const current = active;
    active = null;

    // Clean up temp SSH key used by sync.
    try {
      await cleanupTempKey(pi);
    } catch (cleanupError) {
      console.error("CreateOS: failed to clean up sync key", cleanupError);
    }

    const persisted = _ctx.sessionManager.getSessionFile() !== undefined;
    if (!persisted) {
      try {
        await cli.destroySandbox(pi, current.sandboxId);
      } catch (destroyError) {
        console.error("CreateOS: failed to destroy sandbox", destroyError);
      }
    }
  });
}

async function runStartupLoader<T>(
  ctx: ExtensionContext,
  message: string,
  operation: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (ctx.mode !== "tui") return operation();

  let failure: unknown;
  let cancelled = false;
  const result = await ctx.ui.custom<T | null>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, message);
    loader.onAbort = () => {
      cancelled = true;
      done(null);
    };
    void (async () => {
      try {
        done(await operation(loader.signal));
      } catch (error) {
        failure = error;
        done(null);
      }
    })();
    return loader;
  });

  if (failure !== undefined) throw failure;
  if (cancelled || result === null || result === undefined)
    throw new Error("Startup sync cancelled");
  return result;
}

function latestSessionEntry(ctx: ExtensionContext): SessionEntryData | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: string; customType?: string; data?: unknown };
    if (e.type === "custom" && e.customType === SESSION_ENTRY) return e.data as SessionEntryData;
  }
  return undefined;
}

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
  ctx.ui.setStatus("createos", text === undefined ? undefined : ctx.ui.theme.fg("accent", text));
}
function setRunningStatus(ctx: ExtensionContext, id: string, cwd: string): void {
  setStatus(ctx, `☁ createos · ${shortId(id)} · running · ${cwd}`);
}
function setWatchingStatus(ctx: ExtensionContext, id: string, cwd: string): void {
  setStatus(ctx, `☁ createos · ${shortId(id)} · sync watching · ${cwd}`);
}
function stringFlag(value: boolean | string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
