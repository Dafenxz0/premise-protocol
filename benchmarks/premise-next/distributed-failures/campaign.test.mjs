import assert from "node:assert/strict";
import test from "node:test";
import { runCampaign } from "./runner.mjs";

test("runs every deterministic PostgresValidationFlightStore failure scenario", async () => {
  const report = await runCampaign({ seed: "focused-test" });

  assert.equal(report.mode, "offline-in-memory");
  assert.deepEqual(report.summary, { scenarioCount: 8, passed: 8, failed: 0 });
  assert.equal(report.execution.processesRan, false);
  assert.equal(report.execution.realPostgresRan, false);
  assert.deepEqual(report.scenarios.map(({ id }) => id), [
    "leader-crash-before-completion",
    "expiry-takeover",
    "old-leader-completion",
    "duplicate-completion",
    "aba-scope-change",
    "tenant-isolation",
    "follower-timeout-abort",
    "receipt-replay"
  ]);
});
test("does not silently downgrade an explicitly requested live run", async () => {
  await assert.rejects(
    () => runCampaign({ mode: "live", postgresUrl: "" }),
    /POSTGRES_URL.*offline fallback is used/u
  );
});
