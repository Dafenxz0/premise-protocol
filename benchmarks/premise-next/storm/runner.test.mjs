import test from "node:test";
import assert from "node:assert/strict";
import { runCoherenceStorm, WORKER_COUNT } from "./runner.mjs";

test("runs the deterministic 100-worker coherence storm and passes safety gates", async () => {
  const report = await runCoherenceStorm({ seed: "test-seed" });

  assert.equal(report.workers, WORKER_COUNT);
  assert.equal(report.contract, "runtime-core-dist-complete-scope-smoke");
  assert.equal(report.coordinator, "packages/runtime-core/dist/fenced-single-flight.js");
  assert.equal(report.scope, "complete PremiseValidationScope");
  assert.deepEqual(report.safety, {
    noCrossTenantSharing: true,
    noStaleAccepted: true,
    noOldFenceCommit: true,
    passed: true
  });
  assert.equal(report.limitations.externalServices, false);
  assert.equal(report.limitations.distributedProof, false);
  assert.equal(report.limitations.virtualElapsedTime, true);
  assert.equal(report.limitations.leaseApi, false);
  assert.equal(report.limitations.eventInvalidationApi, false);
  assert.equal(report.phases.length, 8);
  assert.equal(report.metrics.physicalValidations, 111);
  assert.equal(report.metrics.joins, 689);
  assert.ok(report.metrics.staleOutcomes > 0);
  assert.ok(report.metrics.unknownOutcomes > 0);
  assert.ok(report.metrics.sideEffectAttempts > 0);
  assert.ok(report.metrics.elapsedMs > 0);
});

test("keeps exact coalescing, authorization scopes and tenant isolation observable", async () => {
  const { phases } = await runCoherenceStorm({ seed: "shape-seed" });
  const exact = phases.find((phase) => phase.name === "exact-coalescing");
  const scopes = phases.find((phase) => phase.name === "authorization-scopes");
  const tenants = phases.find((phase) => phase.name === "100-tenants-same-resource");

  assert.equal(exact.metrics.physicalValidations, 1);
  assert.equal(exact.metrics.joins, 99);
  assert.equal(exact.metrics.crossTenantShares, 0);
  assert.equal(scopes.metrics.physicalValidations, 2);
  assert.equal(scopes.metrics.joins, 98);
  assert.equal(scopes.metrics.crossScopeShares, 0);
  assert.deepEqual(scopes.outcomeCounts, { UNCHANGED: 100, CHANGED: 0, MISSING: 0, UNKNOWN: 0 });
  assert.equal(scopes.crossScopeFlightsAreFenced, false);
  assert.deepEqual(scopes.fencingTokens, [1, 1]);
  const version = phases.find((phase) => phase.name === "version-supersession");
  assert.deepEqual(version.outcomeCounts, { UNCHANGED: 50, CHANGED: 0, MISSING: 0, UNKNOWN: 50 });
  assert.equal(version.oldOutcome, "FENCED");
  assert.equal(version.currentOutcome, "UNCHANGED");
  assert.deepEqual(version.fencingTokens, [1, 2]);
  assert.equal(tenants.metrics.physicalValidations, 100);
  assert.equal(tenants.metrics.joins, 0);
  assert.equal(tenants.metrics.crossTenantShares, 0);
});

test("fences timeout, abort, mutation and ABA outcomes", async () => {
  const { phases } = await runCoherenceStorm({ seed: "adversarial-seed" });
  const timeout = phases.find((phase) => phase.name === "timeout-via-coordinator");
  const abort = phases.find((phase) => phase.name === "abort-signal-during-flight");
  const mutation = phases.find((phase) => phase.name === "source-mutation-during-validation");
  const aba = phases.find((phase) => phase.name === "old-fence-and-aba");

  assert.equal(timeout.metrics.leaseExpiries, 0);
  assert.equal(timeout.metrics.timeoutSignals, 1);
  assert.equal(timeout.metrics.unknownOutcomes, 100);
  assert.equal(abort.metrics.eventSignals, 1);
  assert.equal(abort.metrics.unknownOutcomes, 100);
  assert.equal(mutation.metrics.staleOutcomes, 100);
  assert.ok(aba.metrics.fenceRejectedAttempts > 0);
  assert.ok(aba.oldFence > 0);
  assert.ok(aba.finalFence > aba.oldFence);
});

test("produces byte-identical JSON for the same seed", async () => {
  const first = await runCoherenceStorm({ seed: "repeatable-seed" });
  const second = await runCoherenceStorm({ seed: "repeatable-seed" });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("rejects a non-100-worker configuration instead of silently changing the experiment", async () => {
  await assert.rejects(() => runCoherenceStorm({ workers: 99 }), /exactly 100 workers/);
});
