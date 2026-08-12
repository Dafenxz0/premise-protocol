import test from "node:test";
import assert from "node:assert/strict";
import { generateGraph, TOPOLOGIES } from "./generators/graphs.mjs";
import { affectedSet, summarizeImpact } from "./oracle/affected-set.mjs";
import { runCampaign } from "./runner.mjs";
import { createMutationEvents, normalizeMutationEvents, replayMutationEvents } from "./generators/events.mjs";
import { anonymizeCandidates, assertNoOracle, evaluateBlind } from "./referee/blind-evaluator.mjs";
import { referenceDecision } from "./oracle/reference-policy.mjs";
import { aggregateCandidateResults } from "./harness/metrics.mjs";

test("all registered graph topologies are deterministic and connected", () => {
  for (const topology of TOPOLOGIES) {
    const first = generateGraph(topology, { nodeCount: topology === "star" ? 10 : 12, seed: "test-seed" });
    const second = generateGraph(topology, { nodeCount: topology === "star" ? 10 : 12, seed: "test-seed" });
    assert.equal(first.metadata.hash, second.metadata.hash);
    assert.equal(first.metadata.acyclic, true);
    assert.equal(first.metadata.connected, true);
  }
});

test("dependency invalidation includes all downstream consumers", () => {
  const graph = generateGraph("diamond", { branches: 4, seed: "diamond-test" });
  const affected = affectedSet(graph, [graph.nodes[0]]);
  assert.equal(affected.size, graph.nodes.length);
  const impact = summarizeImpact(graph, [graph.nodes[0]]);
  assert.equal(impact.affectedCount, graph.nodeCount);
});

test("efficiency campaign keeps safety and work metrics separate", () => {
  const report = runCampaign({ tasks: 40, seed: 7, volatility: 0.5, nodeCount: 24 });
  assert.equal(report.claims.commercialClaimReady, false);
  assert.equal(report.claims.blindReferee, true);
  assert.equal(report.blindEvaluation.status, "COMPLETE");
  assert.equal(report.candidates.premise.unsafeActions, 0);
  assert.equal(report.candidates.always.unsafeActions, 0);
  assert.ok(report.candidates.premise.eventSignals > 0);
  assert.ok(report.candidates.premise.totalWork >= report.candidates.premise.protocolWork);
  assert.notEqual(report.candidates.memory.safeCompletionRate, report.candidates.premise.safeCompletionRate);
});

test("mutation schedules are deterministic and fail closed on gaps", () => {
  const stream = createMutationEvents({ nodeIds: ["a", "b", "c"], schedule: "duplicate", seed: 4 });
  const normalized = normalizeMutationEvents(stream);
  assert.equal(normalized.status, "FRESH");
  assert.equal(normalized.duplicateCount, 1);
  const gapped = normalizeMutationEvents(createMutationEvents({ nodeIds: ["a", "b", "c"], schedule: "gapped", seed: 4 }));
  assert.equal(gapped.status, "UNKNOWN");
  const reordered = normalizeMutationEvents(createMutationEvents({ nodeIds: ["a", "b", "c"], schedule: "reordered", seed: 4 }));
  assert.equal(reordered.status, "FRESH");
  assert.equal(reordered.reordered, true);
  const burst = normalizeMutationEvents(createMutationEvents({ nodeIds: ["a", "b", "c"], schedule: "burst", seed: 4, batchSize: 2 }));
  assert.equal(burst.status, "FRESH");
  assert.equal(replayMutationEvents(new Map(), stream).applied, 3);
});

test("blind referee cannot receive oracle fields", () => {
  assert.throws(() => assertNoOracle({ observation: { truth: "secret" } }), /oracle leakage/);
  const anonymized = anonymizeCandidates([
    { id: "memory", unsafeActions: 4, toctouEscapes: 0, crossTenantReuse: 0, workPerSafeCompletion: 1 },
    { id: "premise", unsafeActions: 0, toctouEscapes: 0, crossTenantReuse: 0, workPerSafeCompletion: 2 }
  ], { seed: 9 });
  assert.equal(anonymized.publicCandidates[0].id, undefined);
  const result = evaluateBlind(anonymized.publicCandidates);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.ranking[0].blindId, anonymized.publicCandidates[1].blindId);
});

test("unknown work stays unknown and cannot enter the blind ranking", () => {
  const complete = {
    completed: 1, safeCompletions: 1, unsafeActions: 0, toctouEscapes: 0, crossTenantReuse: 0,
    sourceReads: 0, writes: 1, requests: 1, eventSignals: 0, validations: 0,
    externalWork: 0, graphWork: 0, protocolWork: 1, reuse: 1, batching: 0,
    incrementality: 0, nodes: 1, edges: 0, dependencies: 0, invalidations: 0,
    minimumWork: 1, staleDetections: 0, staleRecoveries: 0, mutatedAffected: 0, latencyMs: 1
  };
  const aggregate = aggregateCandidateResults([complete, { ...complete, requests: "UNKNOWN" }]);
  assert.equal(aggregate.requests, null);
  assert.equal(aggregate.totalWork, null);
  assert.equal(aggregate.workPerSafeCompletion, null);
  const result = evaluateBlind([
    { blindId: "arm-a", unsafeActions: 0, toctouEscapes: 0, crossTenantReuse: 0, workPerSafeCompletion: 2 },
    { blindId: "arm-b", unsafeActions: 0, toctouEscapes: 0, crossTenantReuse: 0, workPerSafeCompletion: null }
  ]);
  assert.deepEqual(result, { status: "INCONCLUSIVE", reason: "missing efficiency metric", ranking: [] });
});

test("reference policy fails closed and requests revalidation for stale evidence", () => {
  const base = {
    actionDigest: "action-1",
    idempotencyKey: "idempotency-1",
    criticalPremises: ["premise-1"],
    requiredCapability: "CAS",
    capabilities: ["CAS", "IDEMPOTENCY_KEY"]
  };
  assert.equal(referenceDecision({ ...base, receipts: [{ premiseId: "premise-1", state: "STALE", valid: true }] }).decision, "REVALIDATE");
  assert.equal(referenceDecision({ ...base, receipts: [{ premiseId: "premise-1", state: "UNKNOWN", valid: true }] }).decision, "REJECT");
  assert.equal(referenceDecision({ ...base, receipts: [{ premiseId: "premise-1", state: "FRESH", valid: true }] }).decision, "ALLOW");
});
