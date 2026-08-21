import assert from "node:assert/strict";
import { test } from "node:test";

import { createHealthCheckUrl, createScenarioCommand } from "./fanout.ts";

test("runs a scenario from the copied project with quoted environment values", () => {
  const command = createScenarioCommand({
    name: "staging",
    command: "bun test",
    environment: [
      { name: "API_URL", value: "https://staging.example.test" },
      { name: "FEATURE_FLAG", value: "new flow" },
    ],
  });

  assert.match(command, /^cd '\/root\/workspace' && /);
  assert.match(command, /API_URL='https:\/\/staging\.example\.test'/);
  assert.match(command, /FEATURE_FLAG='new flow' bun test$/);
});

test("keeps health checks on the sandbox ingress origin", () => {
  assert.equal(
    createHealthCheckUrl("https://sandbox-3000.example.test", "/health").href,
    "https://sandbox-3000.example.test/health",
  );
  assert.throws(
    () => createHealthCheckUrl("https://sandbox-3000.example.test", "https://169.254.169.254/"),
    /relative/,
  );
  assert.throws(
    () => createHealthCheckUrl("https://sandbox-3000.example.test", "//169.254.169.254/"),
    /relative/,
  );
});
