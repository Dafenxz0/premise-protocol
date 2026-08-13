import assert from "node:assert/strict";
import test from "node:test";
import { runFrontierCampaign } from "./runner.mjs";
import { FROZEN_BASELINE_MANIFEST, verifyFrozenManifest } from "./baseline-artifact.mjs";

test("frontier smoke campaign is differential-equivalent and reports locality", async () => {
  const result = await runFrontierCampaign({ profile: "smoke", seed: 7 });
  assert.equal(result.status, "PASS");
  assert.equal(result.baseline, "c86a6ea");
  assert.equal(result.baselineArtifact.verified, true);
  assert.ok(result.campaigns.length >= 30);
  assert.ok(result.campaigns.every((row) => row.equivalent === true));
  assert.ok(result.campaigns.every((row) => row.changeLocalityRatio !== null));
  assert.ok(result.campaigns.every((row) => row.incremental.accountingReconciled === true));
  assert.ok(result.campaigns.some((row) => row.incremental.cacheHits > 0));
  assert.ok(result.campaigns.some((row) => row.incremental.frontierCacheEntriesPreserved > 0));
  assert.equal(result.claims.commercialClaim, false);
  assert.equal(result.claims.baselineComparisonStatus, "INCONCLUSIVE");
});

test("baseline manifest identity is independently frozen", () => {
  assert.equal(verifyFrozenManifest(FROZEN_BASELINE_MANIFEST), true);
  assert.throws(() => verifyFrozenManifest({ ...FROZEN_BASELINE_MANIFEST, artifactDigest: "sha256:tampered" }), /BASELINE_MANIFEST_NOT_FROZEN:artifactDigest/u);
});

test("diagnostic scale never silently truncates", async () => {
  const result = await runFrontierCampaign({ profile: "diagnostic-xl" });
  assert.equal(result.status, "DIAGNOSTIC_NOT_RUN");
  assert.equal(result.requestedNodeCount, 100_000);
  assert.match(result.reason, /certification/u);
});

test("partial campaigns fail closed instead of producing a certified PASS", async () => {
  const result = await runFrontierCampaign({ profile: "smoke", campaigns: ["validation-amplification"] });
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.campaigns.length, 0);
  assert.match(result.reason, /frozen six-campaign matrix/u);
});
