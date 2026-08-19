import { randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import * as cli from "./cli.ts";
import { syncProjectOnce } from "./startup-sync.ts";
import { shellQuote } from "./util.ts";

const CONCURRENCY = 3;
const REMOTE_DIR = "/root/workspace";

export interface NextjsVariantOptions {
  sourceDir: string;
  count: number;
  namePrefix: string;
  port: number;
  suffixEnv: string;
  shape?: string;
  rootfs?: string;
}

export interface NextjsVariantResult {
  index: number;
  name: string;
  suffix: string;
  sandboxId?: string;
  url?: string;
  verified: boolean;
  error?: string;
}

export function createSuffix(): string {
  return `variant-${randomUUID().slice(0, 8)}`;
}

export function createStartCommand(suffixEnv: string, suffix: string, port: number): string {
  const environment = `${suffixEnv}=${shellQuote(suffix)} PORT=${port}`;
  const server = `cd ${shellQuote(REMOTE_DIR)} && ${environment} bun run start -- -p ${port} -H 0.0.0.0`;
  return `cd ${shellQuote(REMOTE_DIR)} && bun install --frozen-lockfile && ${suffixEnv}=${shellQuote(suffix)} bun run build && (tmux kill-session -t next-app 2>/dev/null || true) && tmux new-session -d -s next-app ${shellQuote(server)}`;
}

export async function deployNextjsVariants(
  pi: ExtensionAPI,
  options: NextjsVariantOptions,
  signal?: AbortSignal,
): Promise<NextjsVariantResult[]> {
  const results: NextjsVariantResult[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (!signal?.aborted) {
      const index = nextIndex++;
      if (index >= options.count) return;
      results[index] = await deployOne(pi, options, index, signal);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, options.count) }, worker));
  if (signal?.aborted) throw new Error("aborted");
  return results;
}

async function deployOne(
  pi: ExtensionAPI,
  options: NextjsVariantOptions,
  index: number,
  signal?: AbortSignal,
): Promise<NextjsVariantResult> {
  const name = `${options.namePrefix}-${String(index + 1).padStart(2, "0")}`;
  const suffix = createSuffix();

  try {
    const sandbox = await cli.createSandbox(pi, {
      shape: options.shape,
      rootfs: options.rootfs,
      name,
      ingress: true,
    });
    await syncProjectOnce(pi, sandbox.id, options.sourceDir, {}, signal);
    const command = createStartCommand(options.suffixEnv, suffix, options.port);
    const started = await cli.sandboxExec(pi, sandbox.id, command, signal);
    if (started.exitCode !== 0) throw new Error(started.stdout || "Next.js start command failed");

    const info = await cli.getSandbox(pi, sandbox.id);
    const url = info.ingress_url_template?.replace("<port>", String(options.port));
    if (!url) throw new Error("Ingress URL is unavailable");

    const verified = await verifyVariant(url, suffix, signal);
    return {
      index: index + 1,
      name,
      suffix,
      sandboxId: sandbox.id,
      url: verified ? url : undefined,
      verified,
      error: verified ? undefined : "public health check failed",
    };
  } catch (error) {
    return {
      index: index + 1,
      name,
      suffix,
      verified: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function verifyVariant(url: string, suffix: string, signal?: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      const timeout = AbortSignal.timeout(5_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch(url, { signal: requestSignal });
      if (response.ok && (await response.text()).includes(suffix)) return true;
    } catch {
      // The server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}
