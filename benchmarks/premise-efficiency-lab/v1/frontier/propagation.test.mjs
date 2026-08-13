import assert from "node:assert/strict";
import test from "node:test";
import { runPropagationCampaign } from "./propagation.mjs";

test("dirty propagation campaign verifies the real baseline, oracle equivalence and safety gates", async () => {
  const result = await runPropagationCampaign({ profile: "smoke", seed: 27 });
  assert.equal(result.status, "PASS");
  assert.equal(result.claims.baselineArtifactVerified, true);
  assert.equal(result.claims.referenceEquivalent, true);
  assert.equal(result.claims.accountingReconciled, true);
  assert.equal(result.claims.allRowsComparable, true);
  assert.equal(result.claims.unknownFailClosed, true);
  assert.equal(result.claims.budgetFailClosed, true);
  assert.equal(result.claims.exhaustiveReferenceEquivalent, true);
  assert.equal(result.exhaustive.status, "PASS");
  assert.equal(result.claims.localityRowsComparable, true);
  assert.ok(result.claims.localityMedianReduction >= 0.2);
  assert.equal(result.claims.commercialClaim, false);
  assert.equal(typeof result.candidate.dirty, "boolean");
  assert.notEqual(result.candidate.artifactDigest, result.baseline.artifactDigest);
  assert.equal(result.rows.length, 6);
  assert.ok(result.rows.filter(({ localityTarget }) => localityTarget).every(({ reduction }) => reduction >= -0.05));
  assert.ok(result.rows.some(({ name, reduction }) => ["repeat-root", "alternate-roots", "cache-locality"].includes(name) && reduction >= 0.2));
});

test("medium dirty propagation campaign is deterministic and keeps the targeted gate", async () => {
  const first = await runPropagationCampaign({ profile: "medium", seed: 27 });
  const second = await runPropagationCampaign({ profile: "medium", seed: 27 });
  assert.equal(first.status, "PASS");
  assert.equal(first.reportDigest, second.reportDigest);
  assert.equal(first.claims.localityPerformanceGate, true);
  assert.equal(first.rows.every(({ candidateWork, baselineWork }) => candidateWork.counters && baselineWork.counters), true);
  assert.deepEqual(first.rows.map(({ name, candidateWork, baselineWork, reduction }) => ({ name, candidateWork, baselineWork, reduction })), second.rows.map(({ name, candidateWork, baselineWork, reduction }) => ({ name, candidateWork, baselineWork, reduction })));
});
