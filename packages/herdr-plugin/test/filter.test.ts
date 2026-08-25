import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { excluded, submodulePrefixes } from "../src/main.ts";

test("the deny-list blocks credential shapes", () => {
  for (const path of [
    ".env",
    "sub/.env.local",
    ".ssh/id_ed25519",
    ".aws/credentials",
    ".kube/config",
    ".config/gcloud/application_default_credentials.json",
    ".git-credentials",
    ".envrc",
    ".pypirc",
    "certs/server.pem",
    "state.tfstate",
  ]) {
    expect(excluded(path, [])).toBe(true);
  }
});

test("example environment files stay eligible", () => {
  expect(excluded(".env.example", [])).toBe(false);
  expect(excluded("sub/.env.sample", [])).toBe(false);
});

test("a user exclude wins over the example-file exception", () => {
  expect(excluded(".env.example", [".env.example"])).toBe(true);
  expect(excluded("big.mp4", ["*.mp4"])).toBe(true);
  expect(excluded("fixtures/a.bin", ["fixtures/"])).toBe(true);
});

test("submodule files never reach the archive", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-sub-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  try {
    const inner = join(root, "inner");
    mkdirSync(inner);
    git(inner, "init", "-q");
    writeFileSync(join(inner, ".env"), "SECRET=leak\n");
    writeFileSync(join(inner, "f.txt"), "hi\n");
    git(inner, "add", "-A");
    git(inner, "commit", "-qm", "i");

    const outer = join(root, "outer");
    mkdirSync(outer);
    git(outer, "init", "-q");
    writeFileSync(join(outer, "a.txt"), "main\n");
    git(outer, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "vendor/sub");
    git(outer, "add", "-A");
    git(outer, "commit", "-qm", "m");

    const submodules = submodulePrefixes(outer);
    expect(submodules).toContain("vendor/sub");

    const listed = git(outer, "ls-files", "-z", "--cached", "--others", "--exclude-standard");
    const kept = listed
      .split("\0")
      .filter(Boolean)
      .filter((p) => !submodules.some((s) => p === s || p.startsWith(`${s}/`)));
    expect(kept).not.toContain("vendor/sub");
    expect(kept).toContain("a.txt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
