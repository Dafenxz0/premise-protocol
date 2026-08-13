import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeNegativeCache, RuntimeReceiptCache, assessEventContinuity, assessOrderedEventContinuity, semanticFingerprint } from "../dist/index.js";

const scope = (overrides = {}) => ({
  tenantId: "tenant:a",
  resourceId: "doc:1",
  incarnationId: "inc:1",
  versionToken: "v1",
  scopes: ["/head"],
  queryDigest: "query:1",
  validatorId: "validator:1",
  authorizationContextDigest: "auth:reader",
  policyDigest: "policy:1",
  changeSetDigest: null,
  causalFrontier: ["event:1"],
  ...overrides
});

test("receipt cache binds all sharing scope fields and rejects stale entries", () => {
  const cache = new RuntimeReceiptCache({ maxEntries: 2 });
  cache.put({ scope: scope(), state: "FRESH", valid: true, observedAt: "2026-08-13T00:00:00Z", expiresAt: "2026-08-13T00:01:00Z", value: { ok: true } });
  assert.equal(cache.get(scope(), "2026-08-13T00:00:30Z").status, "HIT");
  assert.equal(cache.get(scope({ authorizationContextDigest: "auth:writer" }), "2026-08-13T00:00:30Z").status, "MISS");
  assert.equal(cache.get(scope(), "2026-08-13T00:01:00Z").status, "REJECT");
  assert.equal(cache.stats().staleRejections, 1);
});

test("receipt cache snapshots mutable scope arrays and values", () => {
  const cache = new RuntimeReceiptCache({ maxEntries: 2 });
  const input = scope({ scopes: ["/head"], causalFrontier: ["event:1"] });
  cache.put({ scope: input, state: "FRESH", valid: true, observedAt: "2026-08-13T00:00:00Z", expiresAt: "2026-08-13T00:01:00Z", value: { ok: true } });
  input.scopes.push("/admin");
  input.causalFrontier.push("event:2");
  assert.equal(cache.get(scope(), "2026-08-13T00:00:30Z").status, "HIT");
  const lookup = cache.get(scope(), "2026-08-13T00:00:30Z");
  lookup.receipt.scope.scopes.push("/mutated-by-caller");
  assert.equal(cache.get(scope(), "2026-08-13T00:00:30Z").status, "HIT");
});

test("negative cache never presents a negative fact as fresh evidence", () => {
  const cache = new RuntimeNegativeCache();
  cache.put(scope(), "EVENT_GAP", "2026-08-13T00:01:00Z");
  assert.deepEqual(cache.get(scope(), "2026-08-13T00:00:30Z"), { status: "NEGATIVE", reason: "EVENT_GAP" });
  assert.deepEqual(cache.get(scope(), "2026-08-13T00:02:00Z"), { status: "MISS" });
});

test("fingerprints bind incarnation and semantic aspect", () => {
  const first = semanticFingerprint({ resourceId: "doc:1", incarnationId: "inc:1", aspect: "ci", digest: "green" });
  const second = semanticFingerprint({ resourceId: "doc:1", incarnationId: "inc:2", aspect: "ci", digest: "green" });
  assert.notEqual(first, second);
});

test("event continuity fails closed on gaps and accepts duplicates", () => {
  assert.equal(assessEventContinuity([{ sequence: 4 }, { sequence: 4 }, { sequence: 5 }]).status, "FRESH");
  assert.equal(assessEventContinuity([{ sequence: 4 }, { sequence: 6 }]).status, "UNKNOWN");
});

test("ordered event continuity preserves delivery order and distinguishes exact duplicates", () => {
  const base = { streamId: "stream:source", kind: "SNAPSHOT" };
  const fresh = assessOrderedEventContinuity([
    { ...base, sequence: 10, eventId: "e10" },
    { streamId: base.streamId, kind: "DELTA", sequence: 11, eventId: "e11" },
    { streamId: base.streamId, kind: "DELTA", sequence: 11, eventId: "e11" },
    { streamId: base.streamId, kind: "DELTA", sequence: 12, eventId: "e12" }
  ], { expectedSequence: 10, requireSnapshot: true });
  assert.deepEqual(fresh, { status: "FRESH", finalSequence: 12, applied: [10, 11, 12], duplicates: [11] });
  assert.equal(assessOrderedEventContinuity([
    { ...base, sequence: 10, eventId: "e10" },
    { streamId: base.streamId, kind: "DELTA", sequence: 12, eventId: "e12" }
  ]).reason, "GAP");
  assert.equal(assessOrderedEventContinuity([
    { ...base, sequence: 10, eventId: "e10" },
    { streamId: base.streamId, kind: "DELTA", sequence: 11, eventId: "e11" },
    { streamId: base.streamId, kind: "DELTA", sequence: 10, eventId: "late-10" }
  ]).reason, "REORDERED");
  assert.equal(assessOrderedEventContinuity([
    { ...base, sequence: 10, eventId: "e10" },
    { streamId: base.streamId, kind: "DELTA", sequence: 11, eventId: "e11" },
    { ...base, sequence: 10, eventId: "e10" }
  ]).reason, "REORDERED");
  assert.equal(assessOrderedEventContinuity([
    { ...base, sequence: 10, eventId: "e10" },
    { streamId: base.streamId, kind: "DELTA", sequence: 10, eventId: "different-10" }
  ]).reason, "CONFLICT");
});

test("ordered continuity never treats a delta as a snapshot", () => {
  const result = assessOrderedEventContinuity([
    { streamId: "stream:source", kind: "DELTA", sequence: 1, eventId: "d1" }
  ], { requireSnapshot: true });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "DELTA_BEFORE_SNAPSHOT");
});

test("ordered continuity fails closed on malformed events", () => {
  assert.equal(assessOrderedEventContinuity([null]).reason, "INVALID_EVENT");
  assert.equal(assessOrderedEventContinuity([{ streamId: "stream:source", kind: "DELTA", sequence: 1, eventId: 1 }]).reason, "INVALID_EVENT");
});
