import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claimPending, notePendingPane, releasePending } from "../src/lib.ts";

// A start writes its sandbox mapping about 20 seconds after the key press. Until
// then nothing marks the source pane as busy, so a second press starts a second
// provision and bills a second sandbox. These cover the reservation that closes
// that window.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-pending-"));
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HERDR_PLUGIN_STATE_DIR;
});

const NOW = 1_700_000_000_000;

test("the first claim wins and the second is refused", () => {
  expect(claimPending("w1:p1", "box-one", NOW)).toBeNull();

  const held = claimPending("w1:p1", "box-two", NOW + 3_000);
  expect(held).not.toBeNull();
  expect(held?.box).toBe("box-one");
  expect(held?.startedAt).toBe(NOW);
});

test("a claim names the pane it opened, so a retry can point at it", () => {
  claimPending("w1:p1", "box-one", NOW);
  notePendingPane("w1:p1", "w1:p9");

  expect(claimPending("w1:p1", "box-two", NOW + 1_000)?.pane).toBe("w1:p9");
});

test("a different source pane is never blocked", () => {
  claimPending("w1:p1", "box-one", NOW);

  expect(claimPending("w1:p2", "box-two", NOW)).toBeNull();
});

// `pane split --focus` moves focus onto the pane the start just opened, so an
// impatient second press arrives from there. This is the real double-press.
test("a retry from the pane the start opened is refused", () => {
  claimPending("w1:p1", "box-one", NOW);
  notePendingPane("w1:p1", "w1:p9");

  const held = claimPending("w1:p9", "box-two", NOW + 3_000);
  expect(held?.box).toBe("box-one");
});

test("the pane a finished start opened is free again", () => {
  claimPending("w1:p1", "box-one", NOW);
  notePendingPane("w1:p1", "w1:p9");
  releasePending("w1:p1");

  expect(claimPending("w1:p9", "box-two", NOW + 3_000)).toBeNull();
});

test("releasing lets the next start through", () => {
  claimPending("w1:p1", "box-one", NOW);
  releasePending("w1:p1");

  expect(claimPending("w1:p1", "box-two", NOW + 1_000)).toBeNull();
});

test("releasing a pane that holds nothing is not an error", () => {
  releasePending("w1:p1");

  expect(claimPending("w1:p1", "box-one", NOW)).toBeNull();
});

test("a start that died never blocks the pane for good", () => {
  claimPending("w1:p1", "box-one", NOW);

  // Five minutes on, assume the earlier start is gone.
  expect(claimPending("w1:p1", "box-two", NOW + 5 * 60_000)).toBeNull();
  expect(claimPending("w1:p1", "box-three", NOW + 5 * 60_000 + 1)?.box).toBe("box-two");
});
