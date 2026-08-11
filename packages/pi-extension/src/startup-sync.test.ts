import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { sandboxExec } from "./cli.ts";
import {
  createArchiveArgs,
  createExtractCommand,
  selectStartupSync,
  validateLocalSyncSource,
} from "./startup-sync.ts";

describe("selectStartupSync", () => {
  test("selects one-time sync", () => {
    assert.equal(selectStartupSync(true, false), "once");
  });

  test("selects watcher sync", () => {
    assert.equal(selectStartupSync(false, true), "watch");
  });

  test("does nothing without a flag", () => {
    assert.equal(selectStartupSync(false, false), undefined);
  });

  test("rejects incompatible flags", () => {
    assert.throws(() => selectStartupSync(true, true), /mutually exclusive/);
  });
});

test("rejects the home directory as a sync source", async () => {
  await assert.rejects(validateLocalSyncSource(process.env.HOME!), /\$HOME itself/);
});

test("archives project files without VCS metadata", () => {
  assert.deepEqual(createArchiveArgs("/host/project", "/tmp/project.tar.gz"), [
    "-C",
    "/host/project",
    "--exclude=.git",
    "--exclude=.hg",
    "--exclude=.svn",
    "-czf",
    "/tmp/project.tar.gz",
    ".",
  ]);
});

test("forwards cancellation to remote commands", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const pi = {
    exec: async (_command: string, _args: string[], options?: { signal?: AbortSignal }) => {
      receivedSignal = options?.signal;
      return { code: 0, stdout: "", stderr: "" };
    },
  };

  await sandboxExec(pi as never, "sandbox-1", "true", controller.signal);
  assert.equal(receivedSignal, controller.signal);
});

test("quotes archive and destination when extracting", () => {
  assert.equal(
    createExtractCommand("/tmp/a file.tar.gz", "/root/work space"),
    "mkdir -p '/root/work space' && tar -xzf '/tmp/a file.tar.gz' -C '/root/work space' && rm -f '/tmp/a file.tar.gz'",
  );
});
