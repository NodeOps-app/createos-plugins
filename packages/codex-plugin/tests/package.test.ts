import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");

test("shipped stdio server runs from a plugin path with spaces, without node_modules", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "createos-package-"));
  const plugin = join(temporary, "plugin with spaces");
  const workspace = join(temporary, "workspace");
  mkdirSync(workspace);
  mkdirSync(join(plugin, "scripts"), { recursive: true });
  cpSync(join(root, "mcp"), join(plugin, "mcp"), { recursive: true });
  cpSync(join(root, "scripts/start-mcp.sh"), join(plugin, "scripts/start-mcp.sh"));
  const client = new Client({ name: "package-test", version: "1" });
  const transport = new StdioClientTransport({ command: "bash", args: [join(plugin, "scripts/start-mcp.sh")], cwd: workspace, env: { PATH: process.env.PATH!, CREATEOS_JOB_DATA: join(temporary, "data") }, stderr: "pipe" });
  let errors = "";
  transport.stderr?.on("data", (data) => { errors += data.toString(); });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 8);
    const result = await client.callTool({ name: "open_jobs", arguments: {} });
    assert.deepEqual(result.structuredContent, { jobs: [], workspace: realpathSync(workspace) });
    assert.equal(errors, "");
  } finally { await client.close(); }
});

test("manifest hooks execute outside the plugin directory and publish context", () => {
  const temporary = mkdtempSync(join(tmpdir(), "createos-hooks-"));
  const plugin = join(temporary, "plugin with spaces");
  mkdirSync(join(plugin, "scripts"), { recursive: true });
  cpSync(join(root, "scripts/session-start.sh"), join(plugin, "scripts/session-start.sh"));
  cpSync(join(root, "scripts/offload-hint.sh"), join(plugin, "scripts/offload-hint.sh"));
  writeFileSync(join(plugin, "scripts/cos"), "#!/bin/sh\necho 'Test CLI ready'\n", { mode: 0o755 });
  const hooks = JSON.parse(readFileSync(join(root, "hooks/hooks.json"), "utf8")).hooks;
  const env = { ...process.env, PLUGIN_ROOT: plugin, COS_NO_HINT: "" };
  const session = JSON.parse(execFileSync("bash", ["-c", hooks.SessionStart[0].hooks[0].command], { cwd: temporary, env, encoding: "utf8" }));
  assert.equal(session.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(session.hookSpecificOutput.additionalContext, /Test CLI ready/);
  assert.ok(session.hookSpecificOutput.additionalContext.includes(join(plugin, "scripts/cos")));
  const hint = JSON.parse(execFileSync("bash", ["-c", hooks.PreToolUse[0].hooks[0].command], { cwd: temporary, env, input: JSON.stringify({ tool_input: { command: "npm test" } }), encoding: "utf8" }));
  assert.equal(hint.hookSpecificOutput.hookEventName, "PreToolUse");
});
