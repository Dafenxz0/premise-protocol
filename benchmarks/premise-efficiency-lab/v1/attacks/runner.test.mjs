import assert from "node:assert/strict";
import test from "node:test";
import { runAttackSmoke } from "./runner.mjs";

test("attack smoke executes real runtime counters and labels unsupported receipt work", async () => {
  const report = await runAttackSmoke({ profile: "smoke", seed: 20260813 });
  assert.equal(report.status, "COMPLETE_WITH_NOT_RUN_DIMENSION");
  assert.ok(report.validationAmplification.counters.nodesVisited > 0);
  assert.ok(report.singleFlightStampede.counters.singleFlightLeaders >= 1);
  assert.equal(report.receiptCacheAdversarial.status, "NOT_RUN");
  assert.equal(report.gates.noUnsafeActionsInPhysicalSmoke, true);
});

test("diagnostic attack profiles never silently truncate or claim skipped dimensions", async () => {
  const report = await runAttackSmoke({ profile: "diagnostic", seed: 20260814 });
  assert.equal(report.validationAmplification.status, "DIAGNOSTIC_NOT_RUN");
  assert.equal(report.validationAmplification.requestedNodeCount, 100_000);
  assert.equal(report.singleFlightStampede.consumerCount, 1_000);
  assert.equal(report.longHorizonDrift.status, "DIAGNOSTIC_NOT_RUN");
  assert.equal(report.gates.noUnsafeActionsInPhysicalSmoke, "UNKNOWN");
});
