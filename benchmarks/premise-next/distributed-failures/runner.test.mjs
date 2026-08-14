import assert from "node:assert/strict";
import test from "node:test";
import { runDistributedFailureCampaign } from "./runner.mjs";

test("fault campaign exercises the real PostgreSQL flight store contract with an in-memory adapter", async () => {
  const result = await runDistributedFailureCampaign();
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.counts, { leaderCrashes: 1, takeovers: 1, fencedOldLeaders: 1, completedReplays: 1, isolatedScopes: 2, timeouts: 1, aborts: 1 });
});

test("live mode never claims evidence without explicit external configuration", async () => {
  const result = await runDistributedFailureCampaign({ mode: "live" });
  assert.equal(result.status, "SKIPPED");
});
