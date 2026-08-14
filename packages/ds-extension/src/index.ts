/**
 * Shared ownership of one CreateOS Sandbox. The filesystem and subprocess
 * adapters await the same SDK handle, so every path and process they touch
 * inhabits one remote Linux world.
 * @module @createos/dsh
 */

import { posix } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createClient, type CreateSandboxRequest, type Sandbox } from "@nodeops-createos/sandbox";
import { execScriptChecked } from "./exec.ts";

export { SPAWN_MARKER_ENV } from "./exec.ts";
export type { Sandbox } from "@nodeops-createos/sandbox";

/** What happens to the sandbox when the plugin unloads. */
export type DisposeAction = "destroy" | "pause" | "keep";

/** Configuration for the shared CreateOS sandbox owner. */
export interface Config {
  /** API key; omission reads `CREATEOS_SANDBOX_API_KEY`. Never forwarded into the sandbox. */
  apiKey?: string;
  /** Control-plane base URL; omission reads `CREATEOS_SANDBOX_BASE_URL`. */
  baseUrl?: string;
  /** Attach to an existing sandbox by id instead of creating one. */
  sandboxId?: string;
  /** Shape id for a created sandbox. */
  shape?: string;
  /** Rootfs catalog name or template id. Empty = host default. */
  rootfs?: string;
  /** Shared remote working directory, created before adapters receive the sandbox. */
  cwd?: string;
  /**
   * Environment names declared at create time. The control plane treats this
   * map as the allowlist for the exec endpoint's own `env` field, so anything
   * a tool needs to override per call must be declared here first. The
   * subprocess adapter sidesteps the allowlist by carrying its environment in
   * argv, so this is only for values the sandbox should always have.
   */
  envs?: Record<string, string>;
  /** Egress allowlist. Empty or `["*"]` allows all. */
  egress?: string[];
  /** Opt the sandbox into public HTTPS ingress at create time. */
  ingress?: boolean;
  /** Overlay disk size in MiB. Omit for the shape default. */
  diskMib?: number;
  /** Idle auto-pause after this many seconds (60–86400). Omit to disable. */
  autoPauseAfterSeconds?: number;
  /** Disposition of the sandbox when this plugin unloads. */
  disposeAction?: DisposeAction;
}

interface ResolvedConfig extends Config {
  shape: string;
  cwd: string;
  ingress: boolean;
  disposeAction: DisposeAction;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    createos: CreateosRuntime;
  }
}

/**
 * Creates (or attaches to) one CreateOS sandbox and releases it at disposal.
 * Creation begins at plugin construction; adapters await {@link getSandbox}
 * before their first operation.
 */
export class CreateosRuntime extends Service {
  static Config: z<Config> = z.object({
    apiKey: z.string(),
    baseUrl: z.string(),
    sandboxId: z.string(),
    shape: z.string().default("s-2vcpu-2gb"),
    rootfs: z.string(),
    cwd: z.string(),
    envs: z.dict(z.string()),
    egress: z.array(z.string()),
    ingress: z.boolean().default(false),
    diskMib: z.number(),
    autoPauseAfterSeconds: z.number(),
    disposeAction: z.union(["destroy", "pause", "keep"]).default("destroy"),
  });

  /** Validated remote working directory shared by the provider adapters. */
  readonly cwd: string;
  /** Remote directory reserved for adapter-owned staging, spill, and process state. */
  readonly runtimeRoot: string;

  private readonly config: ResolvedConfig;
  private readonly ready: Promise<Sandbox>;
  private disposed = false;

  constructor(ctx: Context, config: Config) {
    super(ctx, "createos");
    // Schemastery fills the defaulted fields before construction; the declared
    // type does not encode that step.
    // Default the remote working directory to the HOST's cwd, mirrored inside
    // the sandbox. The harness seeds each session's workspace root from
    // `process.cwd()` and the bash tool resolves `workdir` from that root, so a
    // sandbox rooted anywhere else makes the agent's very first command fail to
    // chdir (`env -C` exits 125) and the model has to improvise a fallback.
    // Mirroring the path keeps host-shaped paths meaningful on both sides.
    this.config = { ...config, cwd: config.cwd ?? process.cwd() } as ResolvedConfig;
    this.validate();
    this.cwd = this.config.cwd;
    this.runtimeRoot = posix.join(this.cwd, ".dsh-createos");
    this.ready = this.open();
    // A deployment may load the owner before any adapter uses it. Keep a failed
    // eager connection observed; getSandbox() still surfaces the error.
    void this.ready.catch(() => {});

    ctx.effect(
      () => async () => {
        this.disposed = true;
        let sandbox: Sandbox;
        try {
          sandbox = await this.ready;
        } catch {
          // open() either acquired no sandbox or already rolled its own creation back.
          return;
        }
        await this.release(sandbox);
      },
      "createos sandbox teardown",
    );
  }

  /**
   * Return the shared live SDK handle.
   * @returns the sandbox once its working directories exist.
   * @throws when CreateOS rejects creation or the service is disposing.
   */
  async getSandbox(): Promise<Sandbox> {
    if (this.disposed) throw new Error("CreateOS sandbox service is disposing");
    const sandbox = await this.ready;
    // Disposal can race the awaited readiness despite the synchronous precheck.
    if (this.disposed) throw new Error("CreateOS sandbox service is disposing");
    return sandbox;
  }

  private validate(): void {
    if (!posix.isAbsolute(this.config.cwd)) {
      throw new Error(`dsh-createos: cwd must be an absolute Linux path: ${this.config.cwd}`);
    }
    const idle = this.config.autoPauseAfterSeconds;
    if (idle !== undefined && (!Number.isInteger(idle) || idle < 60 || idle > 86_400)) {
      throw new Error(
        "dsh-createos: autoPauseAfterSeconds must be an integer between 60 and 86400",
      );
    }
  }

  private async open(): Promise<Sandbox> {
    const client = createClient({
      ...(this.config.apiKey !== undefined ? { apiKey: this.config.apiKey } : {}),
      ...(this.config.baseUrl !== undefined ? { baseUrl: this.config.baseUrl } : {}),
    });

    // An attached sandbox is borrowed, not owned: prepare it but never roll it back.
    if (this.config.sandboxId !== undefined) {
      const existing = await client.getSandbox(this.config.sandboxId);
      await this.prepare(existing);
      return existing;
    }

    const request: CreateSandboxRequest = {
      shape: this.config.shape,
      ingress_enabled: this.config.ingress,
      ...(this.config.rootfs !== undefined ? { rootfs: this.config.rootfs } : {}),
      ...(this.config.envs !== undefined ? { envs: this.config.envs } : {}),
      ...(this.config.egress !== undefined ? { egress: this.config.egress } : {}),
      ...(this.config.diskMib !== undefined ? { disk_mib: this.config.diskMib } : {}),
      ...(this.config.autoPauseAfterSeconds !== undefined
        ? { auto_pause_after_seconds: this.config.autoPauseAfterSeconds }
        : {}),
    };
    // POST /v1/sandboxes is synchronous end-to-end: it returns only after the
    // VM booted and its in-guest agent answered a readiness probe.
    const sandbox = await client.createSandbox(request);
    try {
      await this.prepare(sandbox);
      return sandbox;
    } catch (error: unknown) {
      try {
        await sandbox.destroy();
      } catch {
        // The original setup failure owns the outcome; a rollback that also
        // fails leaves the sandbox to its own idle/auto-pause policy.
      }
      throw error;
    }
  }

  /** Create the shared working directory and the private runtime root. */
  private async prepare(sandbox: Sandbox): Promise<void> {
    await execScriptChecked(
      sandbox,
      `mkdir -p -- "$1" "$2" && chmod 700 -- "$2" && [ -d "$2" ] && [ ! -L "$2" ]`,
      [this.cwd, this.runtimeRoot],
    );
  }

  private async release(sandbox: Sandbox): Promise<void> {
    if (this.config.disposeAction === "keep") return;
    // An attached sandbox belongs to whoever created it; never destroy it.
    const action =
      this.config.sandboxId !== undefined && this.config.disposeAction === "destroy"
        ? "pause"
        : this.config.disposeAction;
    try {
      if (action === "pause") await sandbox.pause();
      else await sandbox.destroy();
    } catch (error: unknown) {
      // A sandbox already gone is the desired end state, not a teardown failure.
      if (!/not found|404/i.test(String(error))) throw error;
    }
  }
}

export default CreateosRuntime;
