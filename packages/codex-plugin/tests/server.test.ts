import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { artifactUri, createServer, PANEL_URI, type ServerOptions } from "../src/server.ts";

async function fixture(options: ServerOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "createos-mcp-"));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const launched: any[] = [];
  const { server, store } = createServer({ workspace, dataDirectory: join(root, "data"), bundleDirectory: join(import.meta.dirname, "../mcp"), launch: async (job) => { launched.push(job); }, cli: async () => JSON.stringify([{ id: "sandbox-test", name: "test", status: "running", env: { SECRET: "do not return" } }]), ...options });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, store, workspace, launched };
}

test("MCP discovers tools, panel entrypoints, and a bundled UI resource", async () => {
  const { client, server } = await fixture();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 8);
    const panel = tools.find((tool) => tool.name === "open_jobs")!;
    assert.deepEqual(panel._meta?.["openai/ui"], { entrypoints: [{ type: "global" }, { type: "thread" }] });
    const resource = await client.readResource({ uri: PANEL_URI });
    assert.match(String(resource.contents[0].text), /CreateOS Sandbox/);
    assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  } finally { await client.close(); await server.close(); }
});

test("job submission returns immediately, defaults to denied egress, and validates before launch", async () => {
  const { client, server, workspace, launched } = await fixture();
  try {
    const response = await client.callTool({ name: "start_job", arguments: { directory: workspace, command: "printf done" } });
    assert.equal(response.isError, undefined);
    assert.equal((response.structuredContent?.job as any).status, "queued");
    assert.equal(launched[0].network, "denied");
    const invalid = await client.callTool({ name: "start_job", arguments: { directory: workspace, command: "true", artifactPaths: ["../../escape"] } });
    assert.equal(invalid.isError, true);
    assert.equal(launched.length, 1);
    const badId = await client.callTool({ name: "get_job", arguments: { jobId: "../../secret" } });
    assert.equal(badId.isError, true);
  } finally { await client.close(); await server.close(); }
});

test("artifacts round-trip through links and resources without exposing bytes to the model", async () => {
  const { client, server, workspace, store } = await fixture();
  try {
    const job = store.create({ directory: workspace, command: "true", artifactPaths: ["results/report.txt"] });
    mkdirSync(join(store.jobDirectory(job.id), "artifacts"));
    writeFileSync(join(store.jobDirectory(job.id), "artifacts", "0"), "private artifact bytes");
    store.update(job.id, { status: "succeeded", artifacts: [{ name: "results/report.txt", file: "0", bytes: 22 }] });
    const result = await client.callTool({ name: "download_artifact", arguments: { jobId: job.id, name: "results/report.txt" } });
    assert.equal((result.content as any[])[0].type, "resource_link");
    assert.ok(!JSON.stringify(result).includes("private artifact bytes"));
    const resource = await client.readResource({ uri: artifactUri(job.id, "results/report.txt") });
    assert.equal(Buffer.from(String(resource.contents[0].blob), "base64").toString(), "private artifact bytes");
  } finally { await client.close(); await server.close(); }
});

test("sandbox listing omits environment variables and other account metadata", async () => {
  const { client, server } = await fixture();
  try {
    const result = await client.callTool({ name: "list_sandboxes", arguments: {} });
    assert.deepEqual(result.structuredContent, { sandboxes: [{ id: "sandbox-test", name: "test", status: "running" }] });
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  } finally { await client.close(); await server.close(); }
});

test("concurrent requests cannot bypass the server's eight-job limit", async () => {
  const { client, server, workspace, launched } = await fixture();
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => client.callTool({ name: "start_job", arguments: { directory: workspace, command: "true" } })));
    assert.equal(launched.length, 8);
    assert.equal(results.filter((result) => result.isError).length, 4);
  } finally { await client.close(); await server.close(); }
});

test("a vanished worker reports failure without claiming remote cleanup", async () => {
  const { client, server, workspace, store } = await fixture();
  try {
    const job = store.create({ directory: workspace, command: "true", artifactPaths: [] });
    store.update(job.id, { createdAt: "2000-01-01T00:00:00.000Z", status: "running", sandboxId: "sandbox-test" });
    const result = await client.callTool({ name: "get_job", arguments: { jobId: job.id } });
    const current = result.structuredContent?.job as any;
    assert.equal(current.status, "failed");
    assert.equal(current.kept, true);
    assert.match(current.warnings.join(" "), /cleanup are unconfirmed/);
  } finally { await client.close(); await server.close(); }
});

test("a worker completing during recovery checks keeps its terminal result", async () => {
  let update!: (id: string) => void;
  const { client, server, workspace, store } = await fixture({ workerAlive: async (id) => { update(id); return false; } });
  try {
    const job = store.create({ directory: workspace, command: "true", artifactPaths: [] });
    store.update(job.id, { createdAt: "2000-01-01T00:00:00.000Z", status: "running", sandboxId: "sandbox-test" });
    update = (id) => { store.update(id, { status: "succeeded", exitCode: 0, kept: false, finishedAt: new Date().toISOString() }); };
    const result = await client.callTool({ name: "get_job", arguments: { jobId: job.id } });
    const current = result.structuredContent?.job as any;
    assert.equal(current.status, "succeeded");
    assert.equal(current.kept, false);
  } finally { await client.close(); await server.close(); }
});
