import assert from "node:assert/strict";
import test from "node:test";
import { runFrontierCampaign } from "./runner.mjs";

test("frontier smoke campaign is differential-equivalent and reports locality", () => {
  const result = runFrontierCampaign({ profile: "smoke", seed: 7 });
  assert.equal(result.status, "PASS");
  assert.equal(result.baseline, "c86a6ea");
  assert.ok(result.campaigns.length >= 30);
  assert.ok(result.campaigns.every((row) => row.equivalent === true));
  assert.ok(result.campaigns.every((row) => row.changeLocalityRatio !== null));
  assert.ok(result.campaigns.some((row) => row.incremental.cacheHits > 0));
  assert.ok(result.campaigns.some((row) => row.incremental.frontierCacheEntriesPreserved > 0));
  assert.equal(result.claims.commercialClaim, false);
});

test("diagnostic scale never silently truncates", () => {
  const result = runFrontierCampaign({ profile: "diagnostic-xl" });
  assert.equal(result.status, "DIAGNOSTIC_NOT_RUN");
  assert.equal(result.requestedNodeCount, 100_000);
  assert.match(result.reason, /certification/u);
});
