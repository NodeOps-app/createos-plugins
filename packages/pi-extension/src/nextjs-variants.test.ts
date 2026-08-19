import assert from "node:assert/strict";
import { test } from "node:test";

import { createStartCommand, createSuffix } from "./nextjs-variants.ts";

test("creates distinct, shell-safe variant suffixes", () => {
  const first = createSuffix();
  const second = createSuffix();

  assert.match(first, /^variant-[0-9a-f]{8}$/);
  assert.match(second, /^variant-[0-9a-f]{8}$/);
  assert.notEqual(first, second);
});

test("starts a built Next.js variant with its suffix and public port", () => {
  const command = createStartCommand("HELLO_SUFFIX", "variant-deadbeef", 3000);

  assert.match(command, /HELLO_SUFFIX='variant-deadbeef' bun run build/);
  assert.match(command, /tmux new-session -d -s next-app/);
  assert.match(command, /PORT=3000 bun run start -- -p 3000 -H 0\.0\.0\.0/);
});
