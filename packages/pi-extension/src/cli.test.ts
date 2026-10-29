import assert from "node:assert/strict";
import { test } from "node:test";

import { createSandbox, editSandbox, listSandboxes } from "./cli.ts";

test("sandbox creation supplies a default rootfs and preserves explicit images", async () => {
  for (const rootfs of [undefined, "devbox:1", "desktop:1", "my-template"]) {
    let args: string[] = [];
    const pi = {
      async exec(command: string, actualArgs: string[]) {
        assert.equal(command, "createos");
        args = actualArgs;
        return { code: 0, stdout: '{"id":"test-sandbox","status":"running"}', stderr: "" };
      },
    };
    const sandbox = await createSandbox(pi as never, { rootfs });
    assert.equal(sandbox.id, "test-sandbox");
    assert.deepEqual(args, [
      "-o", "json", "sandbox", "create", "--shape", "s-2vcpu-2gb",
      "--rootfs", rootfs ?? "devbox:1",
    ]);
  }
});

test("labels become repeated --label flags; a null list means no matches", async () => {
  const calls: string[][] = [];
  const pi = {
    async exec(_command: string, args: string[]) {
      calls.push(args);
      return { code: 0, stdout: args.includes("list") ? "null" : '{"id":"sb"}', stderr: "" };
    },
  };
  await createSandbox(pi as never, { labels: { team: "a", env: "x=y" } });
  assert.deepEqual(calls[0].slice(-4), ["--label", "team=a", "--label", "env=x=y"]);
  assert.deepEqual(await listSandboxes(pi as never, { team: "a" }), []);
  assert.deepEqual(calls[1], ["-o", "json", "sandbox", "list", "--label", "team=a"]);
  await editSandbox(pi as never, "sb", { labels: { env: "prod" } });
  assert.deepEqual(calls[2], ["sandbox", "edit", "sb", "--label", "env=prod"]);
  await assert.rejects(
    createSandbox(pi as never, { labels: { "a=b": "c" } }),
    /must not contain "="/,
  );
});
