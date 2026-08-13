import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeNegativeCache, RuntimeReceiptCache, assessEventContinuity, semanticFingerprint } from "../dist/index.js";

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
