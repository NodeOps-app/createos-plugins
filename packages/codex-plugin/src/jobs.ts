import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface JobRequest {
  directory: string;
  command: string;
  artifactPaths: string[];
  shape?: string;
  rootfs?: string;
  network?: "denied" | "unrestricted";
  timeoutSeconds?: number;
}

export interface Job extends JobRequest {
  id: string;
  status: "queued" | "staging" | "running" | "succeeded" | "failed";
  createdAt: string;
  finishedAt?: string;
  sandboxId?: string;
  exitCode?: number;
  kept: boolean;
  warnings: string[];
  artifacts: { name: string; file: string; bytes: number }[];
}

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function validateArtifactPath(path: string): string {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(path) || path.split("/").some((p) => p === ".." || p === "." || !p)) {
    throw new Error("Invalid artifact path: use a relative file path under /work, without shell syntax or traversal");
  }
  return path;
}

export class JobStore {
  readonly workspace: string;
  readonly root: string;

  constructor(dataDirectory: string, workspace: string) {
    this.workspace = realpathSync(workspace);
    const key = createHash("sha256").update(this.workspace).digest("hex").slice(0, 24);
    this.root = join(dataDirectory, key);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  jobDirectory(id: string): string {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid job ID");
    return join(this.root, id);
  }

  create(request: JobRequest): Job {
    const directory = this.validateDirectory(request.directory);
    if (!request.command.trim() || request.command.length > 32_768) throw new Error("Command must contain between 1 and 32768 characters");
    const artifacts = [...new Set(request.artifactPaths.map(validateArtifactPath))];
    if (artifacts.length > 20) throw new Error("At most 20 artifact files are supported");
    const job: Job = {
      ...request, directory, artifactPaths: artifacts, network: request.network ?? "denied",
      id: randomUUID(), status: "queued", createdAt: new Date().toISOString(), kept: false, warnings: [], artifacts: [],
    };
    mkdirSync(this.jobDirectory(job.id), { mode: 0o700 });
    this.save(job);
    return job;
  }

  validateDirectory(directory: string): string {
    const path = realpathSync(resolve(this.workspace, directory));
    if (!inside(this.workspace, path) || !statSync(path).isDirectory()) throw new Error("Directory must be inside the configured workspace");
    return path;
  }

  get(id: string): Job {
    return JSON.parse(readFileSync(join(this.jobDirectory(id), "job.json"), "utf8"));
  }

  update(id: string, patch: Partial<Job>): Job {
    const job = { ...this.get(id), ...patch, id };
    this.save(job);
    return job;
  }

  list(limit = 100): Job[] {
    return readdirSync(this.root).flatMap((id) => {
      try { return [this.get(id)]; } catch { return []; }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  logs(id: string): string {
    this.get(id);
    const path = join(this.jobDirectory(id), "log.txt");
    let fd: number;
    try { fd = openSync(path, "r"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
    try {
      const size = statSync(path).size;
      const buffer = Buffer.alloc(Math.min(size, 65_536));
      const bytes = readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      return buffer.subarray(0, bytes).toString("utf8");
    } finally { closeSync(fd); }
  }

  readArtifact(id: string, name: string): Buffer {
    const artifact = this.get(id).artifacts.find((item) => item.name === name);
    if (!artifact) throw new Error("Artifact not found");
    if (!/^\d+$/.test(artifact.file)) throw new Error("Invalid artifact file");
    const root = realpathSync(join(this.jobDirectory(id), "artifacts"));
    const path = realpathSync(join(root, artifact.file));
    if (!inside(root, path) || statSync(path).size > 8 * 1024 * 1024) throw new Error("Invalid or oversized artifact");
    return readFileSync(path);
  }

  private save(job: Job): void {
    const path = join(this.jobDirectory(job.id), "job.json");
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(job), { mode: 0o600 });
    renameSync(temporary, path);
  }
}
