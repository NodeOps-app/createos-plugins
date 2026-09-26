import { test, expect } from "bun:test";
import { CLI } from "./cli.ts";
import { configure } from "./config.ts";
import { job } from "./jobs.ts";

function fixture() {
  let destroyed = 0;
  const cli = new CLI();
  cli.create = async () => "job-box";
  cli.ready = async () => {};
  cli.script = async () => ({ code: 0, stdout: "", stderr: "", truncated: false });
  cli.push = async () => {};
  cli.execute = async () => ({
    code: 0,
    stdout: "done",
    stderr: "",
    truncated: false,
    processId: "process",
  });
  cli.destroy = async () => {
    destroyed++;
  };
  return { cli, destroyed: () => destroyed };
}
test("successful one-shot job releases its sandbox", async () => {
  const fixture_ = fixture();
  const result = await job(fixture_.cli, configure({}, {}), "/project", {
    code: "print(1)",
    lang: "py",
  });
  expect(result.kept).toBe(false);
  expect(fixture_.destroyed()).toBe(1);
});
test("artifact retrieval failure retains output and reports sandbox ID", async () => {
  const fixture_ = fixture();
  fixture_.cli.script = async (_, command) => {
    if (command.includes("test -f")) throw new Error("artifact missing");
    return { code: 0, stdout: "", stderr: "", truncated: false };
  };
  await expect(
    job(fixture_.cli, configure({}, {}), "/project", {
      code: "print(1)",
      lang: "py",
      out: "output.txt",
    }),
  ).rejects.toThrow("job-box retained");
  expect(fixture_.destroyed()).toBe(0);
});
test("uncertain managed execution is retained for inspection", async () => {
  const fixture_ = fixture();
  fixture_.cli.execute = async () => {
    throw new Error("connection lost");
  };
  await expect(
    job(fixture_.cli, configure({}, {}), "/project", { code: "print(1)", lang: "py" }),
  ).rejects.toThrow("retained for recovery");
  expect(fixture_.destroyed()).toBe(0);
});
test("cleanup failure is visible rather than reporting a destroyed sandbox", async () => {
  const fixture_ = fixture();
  fixture_.cli.destroy = async () => {
    throw new Error("unreachable");
  };
  await expect(
    job(fixture_.cli, configure({}, {}), "/project", { code: "print(1)", lang: "py" }),
  ).rejects.toThrow("job-box is still allocated");
});
