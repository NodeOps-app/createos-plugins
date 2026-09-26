import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLI, subprocess } from "./cli.ts";
import { stage } from "./sync.ts";

test("project snapshot includes untracked source and excludes ignored files and VCS metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "createos-sync-test-"));
  try {
    await subprocess("git", ["init", dir]);
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, ".gitignore"), "ignored.txt\n");
    await writeFile(join(dir, "src", "file with spaces.ts"), "export const value = 1;");
    await writeFile(join(dir, "ignored.txt"), "ignored");
    await writeFile(join(dir, ".env"), "TEST_KEY=not-a-real-key");
    await writeFile(join(dir, "node_modules", "large.txt"), "regenerable");
    let archive: string[] = [];
    const cli = new CLI(async (args) => {
      if (args[1] === "push") {
        const result = await subprocess("tar", ["-tzf", args[3]]);
        expect(result.code).toBe(0);
        archive = result.stdout.split("\n").filter(Boolean);
      }
      return { code: 0, stdout: "", stderr: "", truncated: false };
    });
    await stage(cli, "box", dir, "/work");
    expect(archive).toContain("src/file with spaces.ts");
    expect(archive).not.toContain("ignored.txt");
    expect(archive).not.toContain(".env");
    expect(
      archive.some((path) => path.startsWith(".git/") || path.startsWith("node_modules/")),
    ).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
