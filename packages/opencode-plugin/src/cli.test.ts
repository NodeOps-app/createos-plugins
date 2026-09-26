import { test, expect } from "bun:test";
import { CLI, subprocess, type Result } from "./cli.ts";
const json = (value: unknown): Result => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: "",
  truncated: false,
});

test("managed execution returns remote exit code and both output streams", async () => {
  const cli = new CLI(async (args) => {
    if (args.includes("start")) return json({ process_id: "opaque-process" });
    if (args.includes("wait")) return json({ exit_code: 7 });
    if (args.includes("attach")) return { code: 0, stdout: "out", stderr: "err", truncated: false };
    return json({});
  });
  expect(await cli.execute("box", "exit 7", "/work", 1000)).toEqual({
    code: 7,
    stdout: "out",
    stderr: "err",
    truncated: false,
    processId: "opaque-process",
  });
});

test("cancellation during process allocation stops the returned remote tree", async () => {
  const controller = new AbortController();
  const calls: string[][] = [];
  const cli = new CLI(async (args) => {
    calls.push(args);
    if (args.includes("start")) {
      controller.abort();
      return json({ process_id: "late-process" });
    }
    return json({});
  });
  await expect(cli.execute("box", "sleep 100", "/work", 1000, controller.signal)).rejects.toThrow(
    "late-process",
  );
  expect(calls.some((args) => args.includes("stop") && args.includes("late-process"))).toBe(true);
  expect(calls.some((args) => args.includes("wait"))).toBe(false);
});

test("CLI arguments are literal; output is bounded while streams drain", async () => {
  const result = await subprocess("bash", [
    "-c",
    "printf '%s' \"$1\"; head -c 3000000 /dev/zero",
    "_",
    "$(echo injected)",
  ]);
  expect(result.stdout.startsWith("$(echo injected)")).toBe(true);
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(2 * 1024 * 1024);
});

test("timeout terminates a blocked CLI child", async () => {
  await expect(subprocess("sleep", ["60"], { timeout: 20 })).rejects.toThrow("timed out");
});

test("zero deadline remains cancellable without imposing an immediate timeout", async () => {
  const controller = new AbortController();
  const running = subprocess("sleep", ["60"], { timeout: 0, signal: controller.signal });
  const abort = setTimeout(() => controller.abort(), 20);
  try {
    await expect(running).rejects.toThrow("cancelled");
  } finally {
    clearTimeout(abort);
  }
});
