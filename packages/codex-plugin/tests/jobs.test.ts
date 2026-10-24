import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JobStore, validateArtifactPath } from "../src/jobs.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "createos-jobs-"));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  return { root, workspace, store: new JobStore(join(root, "data"), workspace) };
}

test("jobs persist across server restarts and stay scoped to their workspace", () => {
  const { root, workspace, store } = fixture();
  const job = store.create({ directory: workspace, command: "printf hello", artifactPaths: [] });
  assert.equal(new JobStore(join(root, "data"), workspace).get(job.id).status, "queued");
  const other = join(root, "other");
  mkdirSync(other);
  assert.equal(new JobStore(join(root, "data"), other).list().length, 0);
  assert.throws(() => store.get("../../other"), /Invalid job ID/);
});

test("rejects directories outside the workspace, including symlink escapes", () => {
  const { root, workspace, store } = fixture();
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(workspace, "escape"));
  for (const directory of [outside, join(workspace, "escape")]) {
    assert.throws(() => store.create({ directory, command: "pwd", artifactPaths: [] }), /workspace/);
  }
});

test("artifact paths cannot escape /work or inject shell syntax", () => {
  for (const path of ["../secret", "/etc/passwd", "out/../../secret", "x;touch x", "-x", "", "."]) {
    assert.throws(() => validateArtifactPath(path), /artifact path/);
  }
  assert.equal(validateArtifactPath("results/test.json"), "results/test.json");
});

test("downloads only registered artifacts and rejects local symlink escapes", () => {
  const { root, workspace, store } = fixture();
  const job = store.create({ directory: workspace, command: "true", artifactPaths: ["report.txt"] });
  const file = join(store.jobDirectory(job.id), "artifacts", "0");
  mkdirSync(join(store.jobDirectory(job.id), "artifacts"));
  writeFileSync(file, "report");
  store.update(job.id, { status: "succeeded", artifacts: [{ name: "report.txt", file: "0", bytes: 6 }] });
  assert.equal(store.readArtifact(job.id, "report.txt").toString(), "report");
  assert.throws(() => store.readArtifact(job.id, "../secret"), /not found/);
  const secret = join(root, "secret");
  writeFileSync(secret, "secret");
  symlinkSync(secret, join(store.jobDirectory(job.id), "artifacts", "escape"));
  store.update(job.id, { artifacts: [{ name: "escape", file: "escape", bytes: 6 }] });
  assert.throws(() => store.readArtifact(job.id, "escape"), /artifact/);
});

test("log reads are bounded and terminal job state includes cleanup failures", () => {
  const { workspace, store } = fixture();
  const job = store.create({ directory: workspace, command: "true", artifactPaths: [] });
  store.update(job.id, { status: "failed", kept: true, warnings: ["cleanup FAILED"] });
  writeFileSync(join(store.jobDirectory(job.id), "log.txt"), "x".repeat(100_000));
  assert.equal(store.logs(job.id).length, 65_536);
  assert.equal(store.get(job.id).kept, true);
});
