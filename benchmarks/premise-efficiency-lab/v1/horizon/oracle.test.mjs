import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHorizonEvidence } from "./oracle.mjs";

const at = "2026-08-13T00:00:00.000Z";

function event(type, eventId, memoryId, payload) {
  return {
    specVersion: "premise/2",
    tenantId: "tenant:horizon",
    eventId,
    operationId: `operation:${eventId}`,
    idempotencyKey: `idempotency:${eventId}`,
    requestDigest: "sha256:test",
    type,
    occurredAt: at,
    ...(memoryId === undefined ? {} : { memoryId }),
    payload
  };
}

function fixture() {
  const sourceEnvelope = {
    specVersion: "premise/2",
    tenantId: "tenant:horizon",
    memoryId: "memory:source",
    evidence: [],
    validity: { status: "FRESH" },
    dependsOn: []
  };
  const nodeEnvelope = {
    specVersion: "premise/2",
    tenantId: "tenant:horizon",
    memoryId: "memory:node:1",
    evidence: [],
    validity: { status: "STALE" },
    dependsOn: ["memory:source"]
  };
  const events = [
    event("MemoryRegistered", "registered", "memory:source", { envelope: { ...sourceEnvelope, validity: { status: "FRESH" } } }),
    event("MemoryDerived", "derived", "memory:node:1", { dependsOn: ["memory:source"] }),
    event("SourceChanged", "changed", undefined, { sourceUri: "source://horizon/source", version: { scheme: "horizon.source", token: "v2" } }),
    event("MemoryStaled", "staled-source", "memory:source", { sourceUri: "source://horizon/source", version: { scheme: "horizon.source", token: "v2" } }),
    event("MemoryStaled", "staled-node", "memory:node:1", { sourceUri: "source://horizon/source", version: { scheme: "horizon.source", token: "v2" } }),
    event("MemoryRevalidated", "revalidated", "memory:source", { result: "UNCHANGED", status: "FRESH" })
  ];
  const observed = {
    horizonSteps: 1,
    activeRecords: 2,
    eventCount: events.length,
    decisionEvents: 1,
    runtimeErrors: 0,
    frontierErrors: 0,
    receiptEntries: 1,
    eventTypeCounts: { MemoryRegistered: 1, MemoryDerived: 1, SourceChanged: 1, MemoryStaled: 2, MemoryRevalidated: 1 },
    eventBoundary: { first: ["MemoryRegistered", "MemoryDerived", "SourceChanged"], last: ["MemoryStaled", "MemoryStaled", "MemoryRevalidated"] },
    cacheProbe: { receiptEntries: 1, receiptEvictions: 0, negativeCacheEntries: 1 },
    frontierCacheProbe: {
      errors: 0,
      beforeCleanup: { tombstonedRootCount: 2, tombstonedRootEntries: 4 },
      afterLeafQueries: { tombstonedRootEntries: 2 },
      afterCleanup: { tombstonedRootCount: 0, tombstonedRootEntries: 0, trusted: true }
    }
  };
  return {
    steps: 1,
    worldSize: 2,
    observed,
    snapshot: { format: "premise-runtime-snapshot", version: 1, capturedAt: at, records: [
      { envelope: sourceEnvelope, content: { value: "source" } },
      { envelope: nodeEnvelope, content: { value: 1 } }
    ], events },
    decisions: [{ memoryId: "memory:source", decision: "REVALIDATE" }]
  };
}

test("the independent oracle validates raw snapshot semantics", () => {
  const result = evaluateHorizonEvidence(fixture());
  assert.equal(result.pass, true);
  assert.deepEqual(result.errors, []);
});

test("tampering with an event version or dependency fails the oracle", () => {
  const versionTampered = fixture();
  versionTampered.snapshot.events[3].payload.version.token = "forged";
  assert.equal(evaluateHorizonEvidence(versionTampered).pass, false);

  const dependencyTampered = fixture();
  dependencyTampered.snapshot.records[1].envelope.dependsOn = [];
  assert.equal(evaluateHorizonEvidence(dependencyTampered).pass, false);
});
