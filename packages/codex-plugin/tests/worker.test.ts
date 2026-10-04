import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JobStore } from "../src/jobs.ts";
import { runJob } from "../src/worker.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "createos-worker-"));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const store = new JobStore(join(root, "data"), workspace);
  const job = store.create({ directory: workspace, command: "printf done", artifactPaths: [] });
  const calls: string[] = [];
  const engine = {
    assertAuth() {},
    createBox(options: object) { calls.push("create"); assert.equal((options as any).egressDenyAll, true); return { id: "sandbox-test" }; },
    async waitRunning() { return true; },
    stage() { calls.push("stage"); },
    async runKeepalive() { calls.push("run"); return { exitCode: 0, log: "done", infraFailure: false }; },
    destroyBox() { calls.push("destroy"); return { ok: true }; },
  };
  return { store, job, calls, engine };
}

test("successful jobs record output and clean up before reporting success", async () => {
  const { store, job, calls, engine } = fixture();
  await runJob(store, job.id, engine);
  assert.deepEqual(calls, ["create", "stage", "run", "destroy"]);
  assert.equal(store.get(job.id).status, "succeeded");
  assert.equal(store.get(job.id).exitCode, 0);
  assert.equal(store.logs(job.id), "done");
});

test("stage failure still destroys the allocated sandbox", async () => {
  const { store, job, calls, engine } = fixture();
  engine.stage = () => { throw new Error("upload failed"); };
  await runJob(store, job.id, engine);
  assert.deepEqual(calls, ["create", "destroy"]);
  assert.equal(store.get(job.id).status, "failed");
});

test("a failure after remote start keeps the sandbox because execution is unconfirmed", async () => {
  const { store, job, calls, engine } = fixture();
  engine.runKeepalive = async () => { throw new Error("connection lost"); };
  await runJob(store, job.id, engine);
  assert.ok(!calls.includes("destroy"));
  assert.equal(store.get(job.id).kept, true);
  assert.equal(store.get(job.id).status, "failed");
});

test("lost remote process or failed artifact pull preserves the sandbox", async () => {
  const { store, job, calls, engine } = fixture();
  engine.runKeepalive = async () => ({ exitCode: undefined, log: "partial", infraFailure: true });
  await runJob(store, job.id, engine);
  assert.ok(!calls.includes("destroy"));
  assert.equal(store.get(job.id).kept, true);
  assert.equal(store.get(job.id).status, "failed");
});

test("cleanup failure is visible and prevents a success result", async () => {
  const { store, job, engine } = fixture();
  engine.destroyBox = () => ({ ok: false, error: "unavailable" });
  await runJob(store, job.id, engine);
  assert.equal(store.get(job.id).status, "failed");
  assert.equal(store.get(job.id).kept, true);
  assert.match(store.get(job.id).warnings.join(" "), /cleanup FAILED/);
});

test("artifact failure keeps the only remaining copy", async () => {
  const { store, job, engine } = fixture();
  store.update(job.id, { artifactPaths: ["missing.txt"] });
  await runJob(store, job.id, engine, async () => { throw new Error("missing file"); });
  assert.equal(store.get(job.id).kept, true);
  assert.equal(store.get(job.id).status, "failed");
  assert.match(store.get(job.id).warnings.join(" "), /artifact/);
});

test("logs and each downloaded artifact are persisted before cleanup", async () => {
  const { store, job, engine } = fixture();
  store.update(job.id, { artifactPaths: ["report.txt"] });
  engine.destroyBox = () => {
    assert.equal(store.logs(job.id), "done");
    assert.equal(store.get(job.id).exitCode, 0);
    assert.equal(store.readArtifact(job.id, "report.txt").toString(), "report");
    return { ok: true };
  };
  await runJob(store, job.id, engine, async () => Buffer.from("report"));
  assert.equal(store.get(job.id).status, "succeeded");
});

test("a queued directory replaced by an external symlink is not uploaded", async () => {
  const { store, job, calls, engine } = fixture();
  const sub = join(store.workspace, "sub");
  mkdirSync(sub);
  store.update(job.id, { directory: sub });
  renameSync(sub, `${sub}-old`);
  symlinkSync(tmpdir(), sub);
  await runJob(store, job.id, engine);
  assert.equal(store.get(job.id).status, "failed");
  assert.ok(!calls.includes("stage"));
});

test("logs are redacted before artifact collection and cleanup", async () => {
  const { store, job, engine } = fixture();
  const previous = process.env.CREATEOS_API_KEY;
  process.env.CREATEOS_API_KEY = "test-redaction-key";
  engine.runKeepalive = async () => ({ exitCode: 0, log: "test-redaction-key", infraFailure: false });
  let persisted = "";
  engine.destroyBox = () => { persisted = store.logs(job.id); return { ok: true }; };
  try {
    await runJob(store, job.id, engine);
    assert.equal(persisted, "[redacted]");
  } finally {
    if (previous === undefined) delete process.env.CREATEOS_API_KEY;
    else process.env.CREATEOS_API_KEY = previous;
  }
});
