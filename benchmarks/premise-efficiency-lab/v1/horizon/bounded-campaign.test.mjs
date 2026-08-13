import assert from "node:assert/strict";
import test from "node:test";
import { runBoundedRuntimeCampaign } from "./bounded-campaign.mjs";

test("bounded campaign preserves audit count while exposing its replay window", async () => {
  const result = await runBoundedRuntimeCampaign({ horizons: [32], worldSizes: [4], tailSize: 8, checkpointEvery: 8 });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].oracle.pass, true);
  assert.equal(result.rows[0].observed.auditEntries, 32);
  assert.equal(result.rows[0].observed.finalEventTail, 8);
  assert.equal(result.fullReplayProtection, false);
  assert.equal(result.status, "INCONCLUSIVE");
});
