import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { subprocess } from "./cli.ts";
import { fileURLToPath } from "node:url";

async function workspace(
  operation: (
    dir: string,
    run: (op: string, args: unknown) => Promise<{ code: number; data: Record<string, unknown> }>,
  ) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "createos-guest-test-"));
  try {
    await operation(dir, async (op, args) => {
      const result = await subprocess(
        "python3",
        [fileURLToPath(new URL("./guest.py", import.meta.url))],
        { input: JSON.stringify({ cwd: dir, op, args }) },
      );
      return { code: result.code, data: JSON.parse(result.stdout) };
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("remote read, exact edits and atomic writes handle quotes and Unicode", () =>
  workspace(async (dir, run) => {
    const path = "a 'quoted'.txt";
    await run("write", { path, content: "hello\n世界\n" });
    expect((await run("read", { path, offset: 2, limit: 1 })).data.result).toBe("2: 世界");
    await run("edit", { path, oldString: "世界", newString: "remote" });
    expect(await readFile(join(dir, path), "utf8")).toBe("hello\nremote\n");
  }));
test("ambiguous edit fails without mutating file", () =>
  workspace(async (dir, run) => {
    await writeFile(join(dir, "file"), "repeat repeat");
    expect((await run("edit", { path: "file", oldString: "repeat", newString: "x" })).code).toBe(1);
    expect(await readFile(join(dir, "file"), "utf8")).toBe("repeat repeat");
  }));
test("patch validates all hunks before changing files", () =>
  workspace(async (dir, run) => {
    await writeFile(join(dir, "first"), "before\n");
    await writeFile(join(dir, "second"), "unchanged\n");
    const patchText =
      "*** Begin Patch\n*** Update File: first\n@@\n-before\n+after\n*** Update File: second\n@@\n-missing\n+wrong\n*** End Patch";
    expect((await run("patch", { patchText })).code).toBe(1);
    expect(await readFile(join(dir, "first"), "utf8")).toBe("before\n");
  }));
test("patch add/update/move/delete and glob work against real files", () =>
  workspace(async (dir, run) => {
    await writeFile(join(dir, "existing"), "one\ntwo\n");
    await writeFile(join(dir, "gone"), "remove me");
    const patchText =
      "*** Begin Patch\n*** Add File: nested/new.txt\n+hello\n*** Update File: existing\n*** Move to: moved\n@@\n one\n-two\n+three\n*** Delete File: gone\n*** End Patch";
    expect((await run("patch", { patchText })).code).toBe(0);
    expect(await readFile(join(dir, "moved"), "utf8")).toBe("one\nthree\n");
    expect((await run("glob", { pattern: "**/*.txt" })).data.result).toBe("nested/new.txt");
  }));
test("oversized and binary text reads fail explicitly", () =>
  workspace(async (dir, run) => {
    await writeFile(join(dir, "large"), "x".repeat(1024 * 1024 + 1));
    await writeFile(join(dir, "binary"), Buffer.from([255, 254]));
    expect((await run("read", { path: "large" })).code).toBe(1);
    expect((await run("read", { path: "binary" })).code).toBe(1);
  }));
