import type { Plugin } from "@opencode/plugin";
import { createHash } from "node:crypto";
import { CLI, identifier, quote } from "./cli.ts";
import type { Config } from "./config.ts";
import { object } from "./util.ts";
import { stage } from "./sync.ts";

export interface Sandbox {
  id: string;
  cwd: string;
  source: string;
  owned: boolean;
}
type Storage = Plugin.Context["storage"];

/** One owner per session. Allocation is single-flight; durable records survive plugin reload. */
export class Runtime {
  private pending = new Map<string, Promise<Sandbox>>();
  private active = new Map<string, Sandbox>();
  private tasks = new Set<Promise<unknown>>();
  private users = new Map<string, number>();
  private releasing = new Set<string>();
  private closing = false;
  readonly lifetime = new AbortController();
  private prefix: string;
  constructor(
    readonly cli: CLI,
    readonly config: Config,
    readonly source: string,
    private storage: Storage,
    private prepare?: (box: Sandbox, signal: AbortSignal) => Promise<void>,
  ) {
    this.prefix = `v2/${createHash("sha256").update(source).digest("hex")}/`;
  }
  remote(_session: string): boolean {
    return this.config.mode === "remote";
  }
  status(session: string) {
    return {
      mode: this.remote(session) ? "remote" : "local",
      sandbox: this.active.get(session) ?? null,
      initializing: this.pending.has(session),
    };
  }
  async task<T>(
    session: string,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closing) throw new Error("CreateOS plugin is unloading");
    if (this.releasing.has(session)) throw new Error("Session sandbox is being released");
    const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    this.users.set(session, (this.users.get(session) ?? 0) + 1);
    const task = Promise.resolve().then(() => operation(combined));
    this.tasks.add(task);
    try {
      return await task;
    } finally {
      this.tasks.delete(task);
      this.users.set(session, (this.users.get(session) ?? 1) - 1);
    }
  }
  async ensure(session: string, signal?: AbortSignal): Promise<Sandbox> {
    if (this.closing) throw new Error("CreateOS plugin is unloading");
    if (this.releasing.has(session)) throw new Error("Session sandbox is being released");
    signal?.throwIfAborted();
    const active = this.active.get(session);
    if (active) {
      await this.cli.ready(active.id, signal);
      return active;
    }
    let pending = this.pending.get(session);
    if (!pending) {
      pending = this.open(session);
      this.pending.set(session, pending);
      void pending.finally(() => this.pending.delete(session)).catch(() => {});
    }
    const sandbox = await pending;
    signal?.throwIfAborted();
    return sandbox;
  }
  private async open(session: string): Promise<Sandbox> {
    const key = this.prefix + session;
    const stored = await this.storage.get(key);
    let sandbox: Sandbox;
    let created = false;
    let initialized = false;
    if (stored !== undefined) {
      const saved = object(stored);
      if (
        saved.source !== this.source ||
        saved.cwd !== this.config.cwd ||
        typeof saved.owned !== "boolean"
      )
        throw new Error("Stored sandbox configuration changed; release it before reopening");
      sandbox = {
        id: identifier(saved.id),
        source: this.source,
        cwd: this.config.cwd,
        owned: saved.owned,
      };
      initialized = saved.initialized === true;
    } else {
      const id = await this.cli.create(
        { ...this.config, name: `opencode-${crypto.randomUUID().slice(0, 12)}` },
        this.lifetime.signal,
      );
      sandbox = { id, cwd: this.config.cwd, source: this.source, owned: true };
      created = true;
    }
    try {
      if (created && this.config.persist)
        await this.storage.set(key, { ...sandbox, initialized: false });
      await this.cli.ready(sandbox.id, this.lifetime.signal);
      await this.cli.script(sandbox.id, `mkdir -p ${quote(sandbox.cwd)}`, this.lifetime.signal);
      if (!initialized && this.config.sync === "once")
        await stage(this.cli, sandbox.id, this.source, sandbox.cwd, this.lifetime.signal);
      await this.prepare?.(sandbox, this.lifetime.signal);
      if (this.config.persist) await this.storage.set(key, { ...sandbox, initialized: true });
      this.active.set(session, sandbox);
      return sandbox;
    } catch (error) {
      if (created) {
        try {
          await this.cli.destroy(sandbox.id);
          await this.storage.remove(key);
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            `Setup failed; sandbox ${sandbox.id} remains allocated`,
          );
        }
      }
      throw error;
    }
  }
  async destroyExplicit(id: string, caller: string): Promise<void> {
    const bindings = [...this.active].filter(([, box]) => box.id === id);
    for (const [session] of bindings) {
      if ((this.users.get(session) ?? 0) > (session === caller ? 1 : 0))
        throw new Error("Sandbox is in use by another operation");
    }
    await this.cli.destroy(id);
    await Promise.all(bindings.map(([session]) => this.storage.remove(this.prefix + session)));
    for (const [session] of bindings) this.active.delete(session);
  }
  /** Explicit release only, never triggered by session idle or a disconnected UI. */
  async release(session: string, destroy: boolean): Promise<void> {
    if (this.closing) throw new Error("CreateOS plugin is unloading");
    if (this.releasing.has(session)) throw new Error("Session sandbox is already being released");
    if (this.pending.has(session) || this.users.get(session))
      throw new Error("Wait for this session's sandbox operations to finish before release");
    this.releasing.add(session);
    const task = this.releaseOwned(session, destroy);
    this.tasks.add(task);
    try {
      await task;
    } finally {
      this.tasks.delete(task);
      this.releasing.delete(session);
    }
  }
  private async releaseOwned(session: string, destroy: boolean): Promise<void> {
    const saved = this.active.get(session) ?? (await this.storage.get(this.prefix + session));
    if (saved && destroy) {
      const box = object(saved);
      if (box.owned !== true)
        throw new Error("Cannot automatically destroy an externally owned sandbox");
      await this.cli.destroy(identifier(box.id));
    }
    await this.storage.remove(this.prefix + session);
    this.active.delete(session);
    // Remote stays selected: a subsequent operation creates a new sandbox, never falls back to host.
  }
  async close(): Promise<void> {
    this.closing = true;
    this.lifetime.abort();
    await Promise.allSettled([...this.tasks, ...this.pending.values()]);
    if (this.config.persist) return;
    const results = await Promise.allSettled(
      [...this.active]
        .filter(([, box]) => box.owned)
        .map(async ([session, box]) => {
          await this.cli.destroy(box.id);
          await this.storage.remove(this.prefix + session);
        }),
    );
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "CreateOS sandbox cleanup failed");
  }
}
