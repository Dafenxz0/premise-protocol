import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRuntimeStore, PremiseRuntime, RuntimeInstrumentationRecorder } from "../dist/index.js";

const at = "2026-08-13T10:00:00Z";
const envelope = (memoryId, dependsOn = [], sourceUri = "github://example/repo/main", status = "FRESH") => ({
  specVersion: "premise/2",
  tenantId: "tenant:test",
  memoryId,
  evidence: dependsOn.length === 0 ? [{
    evidenceId: `${memoryId}:e`,
    sourceUri,
    observedAt: at,
    version: { scheme: "github.commit", token: "a1" },
    validator: { id: "test", operation: "read" }
  }] : [],
  confidence: { score: null, method: "test", assessedAt: at },
  conflicts: [],
  temporal: { asOf: at },
  validity: { status, checkedAt: at, policy: "MANUAL" },
  dependsOn,
  signatures: []
});

const sharingScope = (evidence, record) => ({
  tenantId: record.envelope.tenantId,
  resourceId: evidence.sourceUri,
  incarnationId: `inc:${evidence.evidenceId}`,
  versionScheme: evidence.version.scheme,
  versionToken: `${evidence.version.scheme}:${evidence.version.token}`,
  scopes: ["read:source"],
  queryDigest: "query:instrumentation-test",
  validatorId: evidence.validator.id,
  authorizationContextDigest: "auth:test",
  policyDigest: "policy:instrumentation-test",
  changeSetDigest: null,
  causalFrontier: []
});

test("runtime instrumentation reports physical invalidation work without changing decisions", () => {
  const recorder = new RuntimeInstrumentationRecorder();
  const runtime = new PremiseRuntime({ tenantId: "tenant:test", now: () => at, instrumentation: recorder, receiptScope: sharingScope });
  runtime.register({ envelope: envelope("memory:root"), content: { value: "root" } });
  runtime.derive({ envelope: envelope("memory:child", ["memory:root"]), content: { value: "child" } });

  assert.deepEqual(runtime.check(["memory:root", "memory:child"]).map((item) => item.decision), ["USABLE", "USABLE"]);
  const affected = runtime.signalSourceChanged("github://example/repo/main", { scheme: "github.commit", token: "b2" });
  assert.deepEqual(affected, ["memory:root", "memory:child"]);

  const counters = recorder.snapshot();
  assert.equal(counters.frontierRecomputes, 0);
  assert.equal(counters.nodesVisited, 2);
  assert.equal(counters.edgesTraversed, 1);
  assert.equal(counters.dirtyPropagations, 1);
  assert.equal(counters.invalidationPropagations, 2);
  assert.equal(counters.recordBatchReads, 1);
  assert.equal(recorder.decisions().length, 2);
});

test("record counters distinguish returned records from a physical getMany call", () => {
  const recorder = new RuntimeInstrumentationRecorder();
  const runtime = new PremiseRuntime({ tenantId: "tenant:test", now: () => at, instrumentation: recorder, receiptScope: sharingScope });
  runtime.register({ envelope: envelope("memory:single"), content: {} });
  runtime.check(["memory:single"]);
  const counters = recorder.snapshot();
  assert.equal(counters.recordBatchReads, 1);
  assert.equal(counters.recordReads, 1);
});

test("instrumentation records single-flight joins for shared evidence", async () => {
  const recorder = new RuntimeInstrumentationRecorder();
  const runtime = new PremiseRuntime({ tenantId: "tenant:test", now: () => at, instrumentation: recorder, receiptScope: sharingScope });
  const sharedEvidence = {
    ...envelope("memory:a").evidence[0],
    evidenceId: "evidence:shared"
  };
  runtime.register({ envelope: { ...envelope("memory:a"), evidence: [sharedEvidence] }, content: { value: "a" } });
  runtime.register({ envelope: { ...envelope("memory:b"), evidence: [sharedEvidence] }, content: { value: "b" } });

  const reports = await runtime.revalidateMany(["memory:a", "memory:b"], async (evidence) => ({
    memoryId: "ignored",
    evidenceId: evidence.evidenceId,
    result: "UNCHANGED",
    status: "FRESH",
    checkedAt: at,
    sourceUri: evidence.sourceUri,
    version: { scheme: "github.commit", token: "a1" }
  }));
  assert.equal(reports.length, 2);
  const counters = recorder.snapshot();
  assert.equal(counters.singleFlightLeaders, 1);
  assert.equal(counters.singleFlightJoins, 1);
  assert.equal(counters.receiptLookups, 0);
});

test("instrumentation failures cannot change a runtime decision", () => {
  const runtime = new PremiseRuntime({
    tenantId: "tenant:test",
    now: () => at,
    instrumentation: {
      onOperation() { throw new Error("telemetry unavailable"); },
      onDecision() { throw new Error("telemetry unavailable"); }
    }
  });
  runtime.register({ envelope: envelope("memory:observer"), content: { value: "ok" } });
  assert.equal(runtime.check(["memory:observer"])[0].decision, "USABLE");
});

test("incremental frontier uses the real runtime path and preserves invalidation coverage", () => {
  const recorder = new RuntimeInstrumentationRecorder();
  const runtime = new PremiseRuntime({
    tenantId: "tenant:test",
    now: () => at,
    instrumentation: recorder,
    incrementalFrontier: true
  });
  runtime.register({ envelope: envelope("memory:frontier-root"), content: { value: "root" } });
  runtime.derive({ envelope: envelope("memory:frontier-child", ["memory:frontier-root"]), content: { value: "child" } });
  assert.deepEqual(runtime.signalSourceChanged("github://example/repo/main", { scheme: "github.commit", token: "c3" }), [
    "memory:frontier-root", "memory:frontier-child"
  ]);
  const frontier = runtime.frontier("memory:frontier-child");
  assert.deepEqual(frontier.frontier, ["memory:frontier-root"]);
  assert.equal(frontier.nodesVisited, 1);
  assert.equal(frontier.edgesTraversed, 0);
  const counters = recorder.snapshot();
  assert.equal(counters.frontierIncrementalUpdates, 1);
  assert.equal(counters.frontierRecomputes, 1);
  // The maintained frontier index answers this query with one lookup instead
  // of walking the child -> root ancestor chain.
  assert.equal(counters.frontierNodesVisited, 1);
  assert.ok(counters.edgesTraversed >= 1);
});

test("incremental frontier restores persisted status and clears a replaced root", () => {
  const store = new InMemoryRuntimeStore();
  const seeded = new PremiseRuntime({ store, tenantId: "tenant:test", now: () => at, incrementalFrontier: true });
  seeded.register({ envelope: envelope("memory:persisted-root", [], undefined, "INVALID"), content: { value: "old" } });
  seeded.derive({ envelope: envelope("memory:persisted-child", ["memory:persisted-root"]), content: { value: "child" } });

  const restored = new PremiseRuntime({ store, tenantId: "tenant:test", now: () => at, incrementalFrontier: true });
  assert.deepEqual(restored.frontier("memory:persisted-child").frontier, ["memory:persisted-root"]);
  assert.equal(restored.frontier("memory:persisted-child").status, "INVALID");

  restored.replace("memory:persisted-root", { value: "new" }, envelope("memory:persisted-root", [], undefined, "FRESH"));
  assert.deepEqual(restored.frontier("memory:persisted-child").frontier, []);
  assert.equal(restored.frontier("memory:persisted-child").status, "FRESH");
});

test("runtime falls back to the complete closure when incremental frontier is incomplete", () => {
  const runtime = new PremiseRuntime({ tenantId: "tenant:test", now: () => at, incrementalFrontier: true });
  const roots = Array.from({ length: 200 }, (_, index) => `memory:budget-root-${index}`);
  for (const memoryId of roots) runtime.register({ envelope: envelope(memoryId), content: { value: memoryId } });
  runtime.derive({ envelope: envelope("memory:budget-target", roots), content: { value: "target" } });

  const affected = runtime.signalSourceChanged("github://example/repo/main", { scheme: "github.commit", token: "budget-b2" });
  assert.equal(affected.length, roots.length + 1);
  assert.equal(new Set(affected).size, affected.length);
  assert.ok(affected.includes("memory:budget-target"));
  assert.equal(runtime.check(["memory:budget-target"])[0].decision, "REVALIDATE");
});

test("single-flight coalesces concurrent revalidation calls across runtime invocations", async () => {
  const recorder = new RuntimeInstrumentationRecorder();
  const runtime = new PremiseRuntime({ tenantId: "tenant:test", now: () => at, instrumentation: recorder, receiptScope: sharingScope });
  const sharedEvidence = { ...envelope("memory:shared").evidence[0], evidenceId: "evidence:cross-call" };
  runtime.register({ envelope: { ...envelope("memory:cross-a"), evidence: [sharedEvidence] }, content: {} });
  runtime.register({ envelope: { ...envelope("memory:cross-b"), evidence: [sharedEvidence] }, content: {} });
  let validations = 0;
  const validator = async (evidence) => {
    validations += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      memoryId: "shared",
      evidenceId: evidence.evidenceId,
      result: "UNCHANGED",
      status: "FRESH",
      checkedAt: at,
      sourceUri: evidence.sourceUri,
      version: evidence.version
    };
  };
  await Promise.all([runtime.revalidateMany(["memory:cross-a"], validator), runtime.revalidateMany(["memory:cross-b"], validator)]);
  const counters = recorder.snapshot();
  assert.equal(validations, 1);
  assert.equal(counters.singleFlightLeaders, 1);
  assert.equal(counters.singleFlightJoins, 1);
});

test("single-flight rebinds a shared observation to each memory record", async () => {
  const runtime = new PremiseRuntime({ tenantId: "tenant:test", now: () => at, receiptScope: sharingScope });
  const sharedEvidence = { ...envelope("memory:shared").evidence[0], evidenceId: "evidence:rebind" };
  runtime.register({ envelope: { ...envelope("memory:rebind-a"), evidence: [sharedEvidence] }, content: {} });
  runtime.register({ envelope: { ...envelope("memory:rebind-b"), evidence: [sharedEvidence] }, content: {} });
  const validator = async (evidence) => ({
    memoryId: "validator-owned-id",
    evidenceId: evidence.evidenceId,
    result: "UNCHANGED",
    status: "FRESH",
    checkedAt: at,
    sourceUri: evidence.sourceUri,
    version: evidence.version
  });
  const reports = await Promise.all([
    runtime.revalidate("memory:rebind-a", validator),
    runtime.revalidate("memory:rebind-b", validator)
  ]);
  assert.deepEqual(reports.map(({ memoryId }) => memoryId).sort(), ["memory:rebind-a", "memory:rebind-b"]);
});
