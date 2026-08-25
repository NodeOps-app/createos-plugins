/** Remote CreateOS environment acquisition and credential scrubbing. */

import type { CreateOSSandbox } from "@nodeops-createos/dsh-createos/createos";
import { SENSITIVE_ENV_PATTERN } from "@deepseek-ai/dsh-subprocess";

function entries(raw: string): Array<readonly [string, string]> {
  const parsed: Array<readonly [string, string]> = [];
  for (const entry of raw.split("\0")) {
    if (entry.length === 0) continue;
    const separator = entry.indexOf("=");
    if (separator > 0) parsed.push([entry.slice(0, separator), entry.slice(separator + 1)]);
  }
  return parsed;
}

/** Read the complete NUL-delimited environment of the CreateOS guest agent. */
export async function readRemoteEnvironment(
  sandbox: CreateOSSandbox,
  signal?: AbortSignal,
): Promise<string> {
  const result = await sandbox.runCommand("/usr/bin/env", ["-0"], {
    retry: false,
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.result.exit_code !== 0) {
    throw new Error(`subprocess-createos: cannot read remote environment: ${result.result.stderr}`);
  }
  return result.result.stdout;
}

/** Produce explicit `env -i` assignments after scrubbing and caller overlay. */
export function environmentArguments(
  raw: string,
  explicit: Readonly<NodeJS.ProcessEnv> | undefined,
): string[] {
  const environment = new Map<string, string>();
  for (const [name, value] of entries(raw)) {
    if (!name.toUpperCase().startsWith("DSH_") && !SENSITIVE_ENV_PATTERN.test(name)) {
      environment.set(name, value);
    }
  }
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (
      name.length === 0 ||
      name.includes("=") ||
      name.includes("\0") ||
      value?.includes("\0") === true
    ) {
      throw new Error("subprocess-createos: environment entries require NUL-free names and values");
    }
    if (value === undefined) environment.delete(name);
    else environment.set(name, value);
  }
  return [...environment].map(([name, value]) => `${name}=${value}`);
}
