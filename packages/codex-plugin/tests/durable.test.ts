import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("a bundled tmux worker completes after the MCP client disconnects", { timeout: 25_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "createos-durable-"));
  const bin = join(root, "bin");
  const workspace = join(root, "workspace with spaces");
  mkdirSync(bin);
  mkdirSync(workspace);
  writeFileSync(join(workspace, "input.txt"), "input");
  const statePath = join(root, "fake-cli-state.json");
  writeFileSync(join(bin, "createos"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.CREATEOS_TEST_STATE;
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const save = () => fs.writeFileSync(file, JSON.stringify(state));
if (args.includes('shapes')) {
  console.log('[]');
} else if (args.includes('create')) {
  state.id = 'test-sandbox'; state.name = args[args.indexOf('--name') + 1]; save();
} else if (args.includes('ls')) {
  console.log(JSON.stringify(state.id ? [{id: state.id, name: state.name, status: 'running'}] : []));
} else if (args.includes('push')) {
  process.stdin.resume();
} else if (args.includes('exec')) {
  const command = args.join(' ');
  if (command.includes('CMD=')) { state.started = true; save(); }
  else if (command.includes('cat /tmp/.cos-run.rc')) console.log('0');
  else if (command.includes('stat -c %s')) console.log('6');
  else if (command.includes('tail')) console.log('remote log');
  else console.log('ok');
} else if (args.includes('pull')) {
  process.stdout.write('report');
} else if (args.includes('rm')) {
  state.deleted = true; save();
} else { process.stderr.write('unexpected fake CLI call'); process.exitCode = 1; }
`, { mode: 0o755 });

  const launcher = resolve(import.meta.dirname, "../scripts/start-mcp.sh");
  const env = { PATH: `${bin}:${process.env.PATH}`, CREATEOS_API_KEY: "fake-test-key", CREATEOS_TEST_STATE: statePath, CREATEOS_JOB_DATA: join(root, "jobs"), CREATEOS_WORKSPACE_ROOT: workspace };
  const connect = async () => {
    const client = new Client({ name: "durability-test", version: "1" });
    await client.connect(new StdioClientTransport({ command: "bash", args: [launcher], cwd: workspace, env, stderr: "pipe" }));
    return client;
  };
  const first = await connect();
  let jobId: string;
  try {
    const response = await first.callTool({ name: "start_job", arguments: { directory: ".", command: "printf report > report.txt", artifactPaths: ["report.txt"] } });
    assert.ok(!response.isError, JSON.stringify(response));
    jobId = (response.structuredContent?.job as any).id;
  } finally { await first.close(); }

  const second = await connect();
  try {
    let job: any;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const response = await second.callTool({ name: "get_job", arguments: { jobId } });
      job = response.structuredContent?.job;
      if (job?.status === "succeeded" || job?.status === "failed") break;
      await new Promise((done) => setTimeout(done, 250));
    }
    assert.equal(job?.status, "succeeded", JSON.stringify(job));
    assert.equal(job.kept, false);
    assert.equal(job.artifacts[0].name, "report.txt");
    const log = await second.callTool({ name: "get_job_logs", arguments: { jobId } });
    assert.match(String(log.structuredContent?.log), /remote log/);
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).deleted, true);
  } finally { await second.close(); }
});
