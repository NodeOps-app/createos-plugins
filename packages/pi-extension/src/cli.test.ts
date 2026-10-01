import assert from "node:assert/strict";
import { test } from "node:test";

import { createSandbox } from "./cli.ts";

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
