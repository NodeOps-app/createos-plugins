import assert from "node:assert/strict";
import { test } from "node:test";
import { execShell } from "../../shared/sandbox-engine.ts";

test("local engine shell keeps pipe failures visible", () => {
  const result = execShell("printf problem >&2; false | cat");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /problem/);
});

test("local engine shell preserves successful output and timeout failure", () => {
  assert.deepEqual(execShell("printf output; printf diagnostic >&2"), { code: 0, stdout: "output", stderr: "" });
  assert.notEqual(execShell("sleep 2", 30).code, 0);
});
