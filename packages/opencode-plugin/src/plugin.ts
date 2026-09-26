import { Plugin } from "@opencode/plugin";
import { CLI } from "./cli.ts";
import { configure } from "./config.ts";
import { Runtime } from "./runtime.ts";
import { Files, remotePath } from "./files.ts";
import { Background } from "./background.ts";
import { registerTools, routeTools } from "./tools.ts";
import { CreateOS } from "./rpc.ts";
import { object, text } from "./util.ts";
import { stage } from "./sync.ts";
import { basename, dirname, isAbsolute } from "node:path";
import { stat } from "node:fs/promises";

export default Plugin.define({
  id: "createos.sandbox",
  async setup(ctx) {
    const config = configure(ctx.options);
    const cli = new CLI();
    const runtime = new Runtime(
      cli,
      config,
      ctx.location.directory,
      ctx.storage,
      async (box, signal) => {
        if (!config.syncSkills) return;
        const skills = await ctx.skill.list();
        const directories = new Set(
          skills.data
            .filter(
              (skill) =>
                isAbsolute(skill.path) && basename(skill.path).toLowerCase() === "skill.md",
            )
            .map((skill) => dirname(skill.path)),
        );
        for (const directory of directories) {
          // Built-in/virtual skills have content but no local bundle to transfer.
          try {
            await stat(directory);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          await stage(cli, box.id, directory, directory, signal);
          const mapped = remotePath(directory, box);
          if (mapped !== directory) await stage(cli, box.id, directory, mapped, signal);
        }
      },
    );
    const files = new Files(runtime.cli);
    const background = new Background();
    try {
      await ctx.tool.transform((editor) => {
        routeTools(editor, runtime, files);
        registerTools(editor, runtime, files, background);
      });
      await ctx.session.hook("context", (event) => {
        const remote = runtime.remote(event.sessionID);
        event.system.push({
          type: "text",
          text: [
            "CreateOS Sandbox is available through sandbox_* tools.",
            "Use sandbox_run_code for one program; sandbox_offload for a project build/test; sandbox_fanout for independent commands.",
            "CreateOS authentication uses the server's createos CLI login or environment. If unavailable, ask the user to run createos login in their own terminal.",
            "Egress is unrestricted by default. Hostname allowlists are not enforced by the recorded control-plane behavior; firewall accepts IP/CIDR rules.",
            remote
              ? `Remote mode: shell/bash, read/write/edit/patch, glob and grep execute in the session's Linux sandbox. Guest cwd: ${config.cwd}. Host project: ${ctx.location.directory}. Project copy: ${config.sync}. Other tools retain their own execution environment. Use explicit push/pull/sync to cross the host/guest boundary. Background commands use sandbox_process_start.`
              : "Built-in tools execute locally. Sandbox tools execute remotely.",
          ].join("\n"),
        });
      });
      await ctx.command.transform((editor) => {
        editor.add({
          name: "sandbox",
          description: "Show CreateOS session status",
          execute: async ({ sessionID }) => {
            await ctx.session.synthetic({
              sessionID,
              text: JSON.stringify(runtime.status(sessionID), null, 2),
              resume: false,
            });
          },
        });
        editor.add({
          name: "sandbox-release",
          description:
            "Destroy and release the session sandbox; pass forget to clear only its binding",
          execute: async ({ sessionID, prompt }) => {
            const argument = prompt.text.trim();
            if (argument && argument !== "forget")
              throw new Error("Usage: /sandbox-release [forget]");
            await runtime.release(sessionID, argument !== "forget");
            await ctx.session.synthetic({
              sessionID,
              text:
                argument === "forget"
                  ? "CreateOS sandbox binding forgotten. Any existing sandbox remains allocated. The next sandbox operation creates a fresh one."
                  : "CreateOS session sandbox released. The next sandbox operation creates a fresh one.",
              resume: false,
            });
          },
        });
      });
      // RPC is location-bound. Verify sessions before returning state or mutating ownership.
      const sessionID = async (
        input: unknown,
        fail: (
          type: "session_unavailable" | "location_mismatch",
          message: string,
          data: { sessionID: string },
        ) => unknown,
      ) => {
        const id = text(object(input).sessionID, "sessionID");
        const session = await ctx.session.get({ sessionID: id }).catch(() => {
          throw fail(
            "session_unavailable",
            "Cannot access this session. Verify the session ID and retry.",
            { sessionID: id },
          );
        });
        if (session.location.directory !== ctx.location.directory)
          throw fail(
            "location_mismatch",
            "Session belongs to a different plugin location. Call this RPC at the session's location.",
            { sessionID: id },
          );
        return id;
      };
      await ctx.rpc.register(CreateOS, {
        status: async (input, context) => runtime.status(await sessionID(input, context.error)),
        release: async (input, context) => {
          const args = object(input);
          if (typeof args.destroy !== "boolean") throw new Error("destroy must be boolean");
          const id = await sessionID(input, context.error);
          try {
            await runtime.release(id, args.destroy);
          } catch (error) {
            // Ordinary exceptions are masked as rpc.internal by OpenCode. Preserve the
            // runtime's actionable refusal/CLI message through the declared error channel.
            return context.error(
              "release_failed",
              error instanceof Error
                ? error.message
                : "CreateOS sandbox release failed. Check session status before retrying.",
              { sessionID: id, destroy: args.destroy },
            );
          }
          return { released: true };
        },
      });
    } catch (error) {
      await background.close();
      await runtime.close();
      throw error;
    }
    return async () => {
      // Quiesce in-flight tools before disposing transports they might still be creating.
      try {
        await runtime.close();
      } finally {
        await background.close();
      }
    };
  },
});
