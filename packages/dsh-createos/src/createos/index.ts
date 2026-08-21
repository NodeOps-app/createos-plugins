/**
 * Shared ownership of one CreateOS sandbox and its managed-process client.
 * Filesystem and subprocess providers await the same remote Linux execution world.
 * @module @nodeops-createos/dsh-createos/createos
 */

import { posix } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
  createClient,
  CreateosSandboxNotFoundError,
  type CreateosSandboxClient,
} from "@nodeops-createos/sandbox";
import type { Sandbox as CreateOSSandbox } from "@nodeops-createos/sandbox";
import { CreateOSProcesses } from "./processes.ts";

export * from "./processes.ts";
export {
  CreateosSandboxError,
  CreateosSandboxNotFoundError,
  Sandbox as CreateOSSandbox,
} from "@nodeops-createos/sandbox";
export type { CreateosSandboxClient } from "@nodeops-createos/sandbox";

/** Configuration for the shared CreateOS sandbox owner. */
export interface Config {
  /** API key; omission reads `CREATEOS_SANDBOX_API_KEY`. */
  apiKey?: string;
  /** Control-plane URL; omission reads the SDK environment/default. */
  baseUrl?: string;
  /** Required CreateOS compute shape. */
  shape: string;
  /** Optional rootfs catalog or template name. */
  rootfs?: string;
  /** Shared remote working directory. */
  cwd?: string;
  /** Sandbox lifetime before owner-initiated destruction. */
  lifetimeMs?: number;
}

interface ResolvedConfig {
  apiKey: string;
  baseUrl?: string;
  shape: string;
  rootfs?: string;
  cwd: string;
  lifetimeMs: number;
}

interface SchemaResolvedConfig extends Config {
  cwd: string;
  lifetimeMs: number;
}

const MAX_LIFETIME_MS = 2_147_483_647;

declare module "@deepseek-ai/cordis" {
  interface Context {
    createos: CreateOSRuntime;
  }
}

/** Creates, shares, and destroys one CreateOS sandbox. */
export class CreateOSRuntime extends Service {
  static Config: z<Config> = z.object({
    apiKey: z.string(),
    baseUrl: z.string(),
    shape: z.string().required(),
    rootfs: z.string(),
    cwd: z.string().default("/root/workspace"),
    lifetimeMs: z.number().default(300_000),
  });

  /** Validated working directory shared by both execution-world adapters. */
  readonly cwd: string;
  /** Remote directory reserved for provider-owned state. */
  readonly runtimeRoot: string;

  private readonly config: ResolvedConfig;
  private readonly client: CreateosSandboxClient;
  private readonly ready: Promise<CreateOSSandbox>;
  private sandboxProcesses: CreateOSProcesses | undefined;
  private disposed = false;
  private lifetimeTimer: NodeJS.Timeout | undefined;

  constructor(ctx: Context, config: Config) {
    super(ctx, "createos");
    const resolved = config as SchemaResolvedConfig;
    this.config = {
      apiKey: config.apiKey ?? process.env.CREATEOS_SANDBOX_API_KEY ?? "",
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      shape: config.shape,
      ...(config.rootfs === undefined ? {} : { rootfs: config.rootfs }),
      cwd: resolved.cwd,
      lifetimeMs: resolved.lifetimeMs,
    };
    this.validate();
    this.cwd = this.config.cwd;
    this.runtimeRoot = posix.join(this.cwd, ".dsh-createos");
    this.client = createClient({
      apiKey: this.config.apiKey,
      ...(this.config.baseUrl === undefined ? {} : { baseUrl: this.config.baseUrl }),
      retry: false,
    });
    this.ready = this.open();
    void this.ready.catch(() => {});

    ctx.effect(
      () => async () => {
        this.disposed = true;
        if (this.lifetimeTimer !== undefined) clearTimeout(this.lifetimeTimer);
        let sandbox: CreateOSSandbox;
        try {
          sandbox = await this.ready;
        } catch {
          // open() owns its one acquired-sandbox rollback.
          return;
        }
        await this.destroy(sandbox);
      },
      "CreateOS sandbox teardown",
    );
  }

  /**
   * Return the shared live sandbox handle.
   * @returns the sandbox after remote setup completes.
   */
  async getSandbox(): Promise<CreateOSSandbox> {
    this.assertAvailable();
    const sandbox = await this.ready;
    this.assertAvailable();
    return sandbox;
  }

  /**
   * Return managed-process access for the shared sandbox.
   * @returns the identity-bound client after remote setup completes.
   */
  async getProcesses(): Promise<CreateOSProcesses> {
    await this.getSandbox();
    return this.sandboxProcesses as CreateOSProcesses;
  }

  /**
   * Return the SDK client used to create the shared sandbox.
   * @returns the configured CreateOS client.
   */
  getClient(): CreateosSandboxClient {
    return this.client;
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error("dsh-createos: sandbox service is disposing");
  }

  private validate(): void {
    if (this.config.apiKey.length === 0) {
      throw new Error("dsh-createos: configure apiKey or set CREATEOS_SANDBOX_API_KEY");
    }
    if (this.config.shape.trim().length === 0)
      throw new Error("dsh-createos: shape must be non-empty");
    if (!posix.isAbsolute(this.config.cwd)) {
      throw new Error(`dsh-createos: cwd must be an absolute Linux path: ${this.config.cwd}`);
    }
    if (
      !Number.isFinite(this.config.lifetimeMs) ||
      this.config.lifetimeMs <= 0 ||
      this.config.lifetimeMs > MAX_LIFETIME_MS
    ) {
      throw new Error(`dsh-createos: lifetimeMs must be between 1 and ${MAX_LIFETIME_MS}`);
    }
  }

  private async open(): Promise<CreateOSSandbox> {
    const sandbox = await this.client.createSandbox(
      {
        shape: this.config.shape,
        ...(this.config.rootfs === undefined ? {} : { rootfs: this.config.rootfs }),
      },
      { retry: false },
    );
    this.sandboxProcesses = new CreateOSProcesses(this.client.http, sandbox.id);
    try {
      const setup = await sandbox.runCommand(
        "/bin/mkdir",
        ["-p", "--", this.cwd, this.runtimeRoot],
        { retry: false },
      );
      if (setup.result.exit_code !== 0) throw new Error(setup.result.stderr || "mkdir failed");
      const inspect = await sandbox.runCommand(
        "/usr/bin/stat",
        ["--format=%F", "--", this.runtimeRoot],
        { retry: false },
      );
      if (inspect.result.exit_code !== 0 || inspect.result.stdout.trim() !== "directory") {
        throw new Error("dsh-createos: reserved runtime path must be a real directory");
      }
      const chmod = await sandbox.runCommand("/bin/chmod", ["700", "--", this.runtimeRoot], {
        retry: false,
      });
      if (chmod.result.exit_code !== 0) throw new Error(chmod.result.stderr || "chmod failed");
      this.lifetimeTimer = setTimeout(() => {
        this.disposed = true;
        void this.destroy(sandbox).catch(() => {});
      }, this.config.lifetimeMs);
      this.lifetimeTimer.unref();
      return sandbox;
    } catch (error: unknown) {
      await this.destroy(sandbox).catch(() => {});
      throw error;
    }
  }

  private async destroy(sandbox: CreateOSSandbox): Promise<void> {
    try {
      await sandbox.destroy({ retry: false });
      if (sandbox.status !== "destroyed") await sandbox.waitUntilDestroyed({ timeoutMs: 120_000 });
    } catch (error: unknown) {
      if (!(error instanceof CreateosSandboxNotFoundError)) throw error;
    }
  }
}

export default CreateOSRuntime;
