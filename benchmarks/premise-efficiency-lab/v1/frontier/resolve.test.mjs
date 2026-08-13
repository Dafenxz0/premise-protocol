import assert from "node:assert/strict";
import test from "node:test";
import { runResolveCampaign } from "./resolve.mjs";

test("incremental resolve campaign is reference-equivalent and fails closed for UNKNOWN", () => {
  const result = runResolveCampaign({ profile: "smoke", seed: 26 });
  assert.equal(result.status, "PASS");
  assert.equal(result.rows.length, 3);
  assert.equal(result.claims.referenceEquivalent, true);
  assert.equal(result.claims.unknownFailClosed, true);
  assert.equal(result.claims.accountingReconciled, true);
  assert.equal(result.claims.performanceClaim, false);
  assert.ok(result.rows.every((row) => row.tombstonedRootEntries >= 0));
  assert.ok(result.rows.every((row) => row.resolveMaintenanceWork >= 0));
  assert.equal(result.rows[0].nodeCount, 64);
  assert.notEqual(result.rows[0].seed, undefined);
});

test("medium resolve campaign remains bounded and deterministic", () => {
  const first = runResolveCampaign({ profile: "medium", seed: 26 });
  const second = runResolveCampaign({ profile: "medium", seed: 26 });
  const differentSeed = runResolveCampaign({ profile: "medium", seed: 27 });
  assert.equal(first.status, "PASS");
  assert.equal(first.reportDigest, second.reportDigest);
  assert.notEqual(first.reportDigest, differentSeed.reportDigest);
  assert.deepEqual(first.rows.map(({ topology, work }) => ({ topology, work })), second.rows.map(({ topology, work }) => ({ topology, work })));
});
