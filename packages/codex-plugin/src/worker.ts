import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import * as sharedEngine from "../../shared/sandbox-engine.ts";
import { JobStore, type Job } from "./jobs.ts";

const exec = promisify(execFile);
type Engine = Pick<typeof sharedEngine, "assertAuth" | "createBox" | "waitRunning" | "stage" | "runKeepalive" | "destroyBox">;

// Pull individual files as bounded bytes. Do not extract an archive supplied by
// a sandbox into the user's checkout or trust remote symlinks.
export async function pullArtifact(sandboxId: string, name: string): Promise<Buffer> {
  const path = `/work/${name}`;
  const check = 'p=$(realpath -e -- "$1") || exit 1; case "$p" in /work/*) test -f "$p" || exit 1;; *) exit 1;; esac; stat -c %s -- "$p"';
  const sizeResult = await exec("createos", ["sandbox", "exec", sandboxId, "--", "bash", "-c", check, "_", path], { timeout: 30_000 });
  const size = Number(sizeResult.stdout.trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > 8 * 1024 * 1024) throw new Error(`artifact ${name} exceeds 8 MiB or is not a regular file under /work`);
  const result = await exec("createos", ["sandbox", "pull", sandboxId, path, "-"], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 60_000 });
  return result.stdout;
}

export async function runJob(store: JobStore, id: string, engine: Engine = sharedEngine, pull = pullArtifact): Promise<void> {
  let job = store.get(id);
  let sandboxId: string | undefined;
  let kept = false;
  let exitCode: number | undefined;
  let log = "";
  let executionStarted = false;
  let failed = false;
  const key = process.env.CREATEOS_API_KEY;
  const warnings: string[] = [];
  const artifacts: Job["artifacts"] = [];
  try {
    job.directory = store.validateDirectory(job.directory);
    engine.assertAuth();
    const created = engine.createBox({
      name: `cos-j-${id.slice(0, 12)}`, shape: job.shape, rootfs: job.rootfs,
      egressDenyAll: job.network !== "unrestricted", egressAll: job.network === "unrestricted",
    });
    sandboxId = created.id;
    if (job.network === "unrestricted") warnings.push("Egress is unrestricted: this sandbox can access the internet.");
    job = store.update(id, { sandboxId, status: "staging", warnings });
    if (!await engine.waitRunning(sandboxId)) throw new Error("Sandbox did not become running");
    engine.stage(sandboxId, store.validateDirectory(job.directory), [".env", ".env.*", ".ssh", ".aws", ".createos"]);
    store.update(id, { status: "running" });
    executionStarted = true;
    const result = await engine.runKeepalive(sandboxId, job.command, "/work", { timeoutMs: (job.timeoutSeconds ?? 21_600) * 1000 });
    exitCode = result.exitCode;
    log = key ? result.log.split(key).join("[redacted]") : result.log;
    writeFileSync(join(store.jobDirectory(id), "log.txt"), log, { mode: 0o600 });
    store.update(id, { exitCode });
    if (result.infraFailure) {
      kept = true;
      warnings.push("Remote execution could not be confirmed. Sandbox is kept for recovery.");
    }
    mkdirSync(join(store.jobDirectory(id), "artifacts"), { mode: 0o700 });
    for (const name of job.artifactPaths) {
      try {
        const bytes = await pull(sandboxId, name);
        const file = String(artifacts.length);
        writeFileSync(join(store.jobDirectory(id), "artifacts", file), bytes, { mode: 0o600 });
        artifacts.push({ name, file, bytes: bytes.length });
        store.update(id, { artifacts });
      } catch {
        kept = true;
        warnings.push(`Failed to retrieve artifact ${name}. Sandbox is kept so the only copy is not destroyed.`);
      }
    }
  } catch (error) {
    failed = true;
    if (executionStarted) {
      kept = true;
      warnings.push("Execution or artifact collection is unconfirmed. Sandbox is kept for recovery.");
    }
    warnings.push(error instanceof Error ? error.message : String(error));
  }
  if (sandboxId && !kept) {
    try {
      const result = engine.destroyBox(sandboxId);
      if (!result.ok) { kept = true; warnings.push(`cleanup FAILED — sandbox ${sandboxId} remains allocated.`); }
    } catch {
      kept = true;
      warnings.push(`cleanup FAILED — sandbox ${sandboxId} remains allocated.`);
    }
  }
  if (key) log = log.split(key).join("[redacted]");
  writeFileSync(join(store.jobDirectory(id), "log.txt"), log, { mode: 0o600 });
  store.update(id, {
    status: exitCode === 0 && !kept && !failed ? "succeeded" : "failed", finishedAt: new Date().toISOString(),
    exitCode, kept, warnings: warnings.map((message) => key ? message.split(key).join("[redacted]") : message), artifacts,
  });
}
