import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subprocess } from "./cli.ts";
import { log } from "./util.ts";

/** Plugin-owned local transports; child groups and ephemeral SSH keys share one lifetime. */
export class Background {
  private entries = new Map<string, { child: ChildProcess; key?: string; done: Promise<void> }>();
  async start(args: string[], key?: string): Promise<string> {
    const id = crypto.randomUUID();
    const child = spawn(process.env.CREATEOS_BIN ?? "createos", args, {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, NO_COLOR: "1" },
    });
    const done = new Promise<void>((resolve) => child.once("close", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    this.entries.set(id, { child, key, done });
    return id;
  }
  async watch(id: string, local: string, remote: string, mode: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "createos-sync-"));
    try {
      const key = join(dir, "id_ed25519");
      const result = await subprocess("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
      if (result.code !== 0) throw new Error(result.stderr);
      return await this.start(
        [
          "sandbox",
          "sync",
          "--yes",
          "--local",
          local,
          "--remote",
          remote,
          "--mode",
          mode,
          "--exclude",
          ".git",
          "--exclude",
          "node_modules",
          "--exclude",
          ".env",
          "-i",
          key,
          id,
        ],
        dir,
      );
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  list() {
    return [...this.entries].map(([id, entry]) => ({
      id,
      running: entry.child.exitCode === null && entry.child.signalCode === null,
    }));
  }
  async stop(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Unknown local transport ID");
    if (entry.child.pid && entry.child.exitCode === null && entry.child.signalCode === null) {
      const kill = (signal: NodeJS.Signals) => {
        try {
          process.kill(-entry.child.pid!, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };
      kill("SIGTERM");
      const timer = setTimeout(() => {
        try {
          kill("SIGKILL");
        } catch (error) {
          log("transport.kill.failed", error);
        }
      }, 1000);
      try {
        await entry.done;
      } finally {
        clearTimeout(timer);
      }
    }
    if (entry.key) await rm(entry.key, { recursive: true, force: true });
    this.entries.delete(id);
  }
  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.entries.keys()].map((id) => this.stop(id)));
    const errors = results.filter((item) => item.status === "rejected").map((item) => item.reason);
    if (errors.length) throw new AggregateError(errors, "Transport cleanup failed");
  }
}
