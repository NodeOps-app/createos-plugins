/**
 * Offline test of `cordis.patch.yml` — the composition layer.
 *
 * This is the cheapest rung that can catch a composition bug. The provider code
 * can typecheck, unit-test, and pass a live smoke test against a real sandbox
 * while every bash call the agent makes still fails, because the breakage lives
 * in how this patch layers over `dsh-base`. Running the loader's own
 * `applyEntryPatches` against a synthetic base entry list reproduces that
 * layering in milliseconds, with no network and no harness.
 *
 * The `warnings` assertion is the important one: a patch row whose `id` matches
 * nothing is a silent no-op at boot, so a typo would otherwise only show up as
 * mysterious runtime behavior.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  applyEntryPatches,
  entryListSchema,
  type PatchOptions,
} from "@deepseek-ai/cordis-plugin-include";
import yaml from "js-yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The `dsh-base` rows this bundle depends on, with their upstream defaults. */
function baseEntries() {
  return [
    { id: "subprocess", name: "@deepseek-ai/dsh-subprocess-local" },
    { id: "fs-sandbox", name: "@deepseek-ai/dsh-fs-sandbox" },
    { id: "sandbox", name: "@deepseek-ai/dsh-sandbox-local" },
    {
      id: "sandbox-policy",
      name: "@deepseek-ai/dsh-sandbox-policy",
      config: { mode: "workspace-write", workspaceRoot: "/host" },
    },
    {
      id: "bash-sandbox",
      name: "@deepseek-ai/dsh-bash-sandbox",
      disabled: true,
      config: { timeoutMs: 60000 },
    },
    { id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash", disabled: true },
    { id: "approval", name: "@deepseek-ai/dsh-user-approval", config: { policy: "ask" } },
    { id: "permission", name: "@deepseek-ai/dsh-permission-presets" },
  ];
}

function compose() {
  const patches = yaml.load(readFileSync(resolve(root, "cordis.patch.yml"), "utf8"), {
    schema: entryListSchema,
  }) as PatchOptions[];
  const warnings: string[] = [];
  const entries = applyEntryPatches(baseEntries(), patches, (message, ...args) => {
    warnings.push([message, ...args].join(" "));
  });
  return { entries, warnings };
}

const row = (entries: ReturnType<typeof compose>["entries"], id: string) =>
  entries.find((entry) => entry.id === id);

describe("cordis.patch.yml", () => {
  test("every patch row matches a base row (no silently-ignored id typos)", () => {
    const { warnings } = compose();
    expect(warnings).toEqual([]);
  });

  test("the local execution world is switched off", () => {
    const { entries } = compose();
    // A second provider for `fs` or `subprocess` is a duplicate-service error,
    // not a fallback, so these must be off rather than layered under ours.
    expect(row(entries, "subprocess")?.disabled).toBe(true);
    expect(row(entries, "fs-sandbox")?.disabled).toBe(true);
  });

  test("the sandbox provider stays mounted", () => {
    const { entries } = compose();
    // dsh-bash-sandbox INJECTS `sandbox`; disabling it strands the whole shell
    // chain in PENDING and boot fails with "entries did not activate".
    expect(row(entries, "sandbox")?.disabled).toBeUndefined();
  });

  test("bash is re-enabled regardless of host platform", () => {
    const { entries } = compose();
    // The base disables both on win32, which is right for a local world and
    // wrong for a remote Linux one.
    expect(row(entries, "bash-sandbox")?.disabled).toBe(false);
    expect(row(entries, "tool-bash")?.disabled).toBe(false);
  });

  test("confinement is delegated to the microVM", () => {
    const { entries } = compose();
    // Only in danger-full-access does bash-sandbox delegate straight to
    // ctx.subprocess instead of wrapping argv in a host backend.
    expect(row(entries, "sandbox-policy")?.config).toMatchObject({ mode: "danger-full-access" });
  });

  test("approval and preset defaults agree", () => {
    const { entries } = compose();
    // These two disagreeing is invisible on a surface with no approval channel
    // and produces prompts or an escalation failure everywhere else.
    expect(row(entries, "approval")?.config).toEqual({ policy: "never" });
    const permission = row(entries, "permission")?.config as {
      defaultPreset?: string;
      presets?: Record<string, { sandbox: string; approval: string }>;
    };
    expect(permission?.defaultPreset).toBe("danger-full-access");
    expect(permission?.presets?.["danger-full-access"]).toEqual({
      sandbox: "danger-full-access",
      approval: "never",
    });
  });

  test("only presets that can actually work are offered", () => {
    const { entries } = compose();
    const permission = row(entries, "permission")?.config as {
      presets?: Record<string, unknown>;
    };
    // read-only / workspace-write describe HOST confinement and cannot describe
    // a microVM boundary; offering them would let a session pick a mode that
    // refuses to run.
    expect(Object.keys(permission?.presets ?? {})).toEqual(["danger-full-access"]);
  });

  test("overriding one key does not drop its siblings", () => {
    const { entries } = compose();
    // A patch replaces a row's WHOLE config, so pinning cwd silently dropped
    // the base's command timeout until it was restated.
    expect(row(entries, "bash-sandbox")?.config).toMatchObject({ timeoutMs: 60000 });
  });

  test("the three providers are inserted", () => {
    const { entries } = compose();
    expect(
      entries
        .filter((entry) => typeof entry.name === "string" && entry.name.startsWith("@createos/dsh"))
        .map((entry) => entry.name),
    ).toEqual(["@createos/dsh", "@createos/dsh/fs", "@createos/dsh/subprocess"]);
  });

  test("the package declares the bundle and its entry points", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      dsh?: { bundle?: { patch?: string } };
      exports?: Record<string, unknown>;
      files?: string[];
    };
    expect(manifest.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
    // Object.keys, not toHaveProperty: a "./fs" argument is read as a dotted key path.
    const exported = Object.keys(manifest.exports ?? {});
    expect(exported).toContain(".");
    expect(exported).toContain("./fs");
    expect(exported).toContain("./subprocess");
    expect(manifest.files).toContain("cordis.patch.yml");
  });
});
