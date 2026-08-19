import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import * as cli from "./cli.ts";
import { syncProjectOnce } from "./startup-sync.ts";
import { shellQuote } from "./util.ts";

const CONCURRENCY = 3;
const REMOTE_DIR = "/root/workspace";

export interface FanoutScenario {
  name: string;
  command: string;
  environment: Array<{ name: string; value: string }>;
  port?: number;
  healthCheckPath?: string;
  healthCheckContains?: string;
}

export interface FanoutOptions {
  sourceDir: string;
  namePrefix: string;
  scenarios: FanoutScenario[];
  shape?: string;
  rootfs?: string;
}

export interface FanoutResult {
  name: string;
  sandboxId?: string;
  url?: string;
  verified: boolean;
  output?: string;
  error?: string;
}

export function createScenarioCommand(scenario: FanoutScenario): string {
  const environment = scenario.environment.map(({ name, value }) => `${name}=${shellQuote(value)}`).join(" ");
  return `cd ${shellQuote(REMOTE_DIR)} && ${environment ? `${environment} ` : ""}${scenario.command}`;
}

export async function fanoutScenarios(
  pi: ExtensionAPI,
  options: FanoutOptions,
  signal?: AbortSignal,
): Promise<FanoutResult[]> {
  const results: FanoutResult[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (!signal?.aborted) {
      const index = nextIndex++;
      if (index >= options.scenarios.length) return;
      results[index] = await runScenario(pi, options, options.scenarios[index], signal);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, options.scenarios.length) }, worker));
  if (signal?.aborted) throw new Error("aborted");
  return results;
}

async function runScenario(
  pi: ExtensionAPI,
  options: FanoutOptions,
  scenario: FanoutScenario,
  signal?: AbortSignal,
): Promise<FanoutResult> {
  const name = `${options.namePrefix}-${scenario.name}`;
  let sandboxId: string | undefined;

  try {
    const sandbox = await cli.createSandbox(pi, {
      shape: options.shape,
      rootfs: options.rootfs,
      name,
      ingress: scenario.port !== undefined,
    });
    sandboxId = sandbox.id;
    await syncProjectOnce(pi, sandbox.id, options.sourceDir, {}, signal);
    const command = createScenarioCommand(scenario);

    if (!scenario.port) return await runForeground(pi, sandbox.id, name, command, signal);

    const started = await cli.sandboxExec(
      pi,
      sandbox.id,
      `(tmux kill-session -t scenario 2>/dev/null || true) && tmux new-session -d -s scenario ${shellQuote(command)}`,
      signal,
    );
    if (started.exitCode !== 0) throw new Error(started.stdout || "Scenario start command failed");

    const info = await cli.getSandbox(pi, sandbox.id);
    const url = info.ingress_url_template?.replace("<port>", String(scenario.port));
    if (!url) throw new Error("Ingress URL is unavailable");

    const verified = await verifyScenario(url, scenario, signal);
    if (!verified) {
      await cli.destroySandbox(pi, sandbox.id).catch(() => undefined);
      return { name, sandboxId: sandbox.id, verified: false, error: "public health check failed" };
    }
    return { name, sandboxId: sandbox.id, url, verified: true };
  } catch (error) {
    if (sandboxId) await cli.destroySandbox(pi, sandboxId).catch(() => undefined);
    return {
      name,
      sandboxId,
      verified: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runForeground(
  pi: ExtensionAPI,
  sandboxId: string,
  name: string,
  command: string,
  signal?: AbortSignal,
): Promise<FanoutResult> {
  const result = await cli.sandboxExec(pi, sandboxId, command, signal);
  try {
    await cli.destroySandbox(pi, sandboxId);
  } catch (error) {
    return {
      name,
      sandboxId,
      verified: false,
      output: result.stdout,
      error: `scenario cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (result.exitCode !== 0) {
    return { name, sandboxId, verified: false, output: result.stdout, error: "scenario command failed" };
  }
  return { name, sandboxId, verified: true, output: result.stdout };
}

export function createHealthCheckUrl(url: string, path = "/"): URL {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("health check path must be relative");
  const endpoint = new URL(path, url);
  if (endpoint.origin !== new URL(url).origin) throw new Error("health check must use the sandbox ingress URL");
  return endpoint;
}

async function verifyScenario(url: string, scenario: FanoutScenario, signal?: AbortSignal): Promise<boolean> {
  const endpoint = createHealthCheckUrl(url, scenario.healthCheckPath);
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      const timeout = AbortSignal.timeout(5_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch(endpoint, { signal: requestSignal, redirect: "error" });
      const body = await response.text();
      if (response.ok && (!scenario.healthCheckContains || body.includes(scenario.healthCheckContains))) return true;
    } catch {
      // The process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}
