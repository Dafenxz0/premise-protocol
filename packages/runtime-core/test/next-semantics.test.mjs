import assert from "node:assert/strict";
import test from "node:test";
import {
  NegativePremiseStore,
  createPredicateDependency,
  classifyPredicateChange,
  assessReceiptSubsumption,
  selectSubsumingReceipt
} from "../dist/index.js";

const scope = (extra = {}) => ({
  tenantId: "tenant-a", resource: "inventory", incarnationId: "i1", queryDigest: "q1", frontierDigest: "f1", authorizationContextDigest: "auth-a", ...extra
});

test("negative premises are scoped, bounded and fail closed", () => {
  const store = new NegativePremiseStore({ maxEntries: 2, maxEntriesPerTenant: 1 });
  store.putAbsent({ ...scope(), reason: "no-conflict", observedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T01:00:00Z" });
  const observation = { entityPresent: false, frontierDigest: "f1", incarnationId: "i1" };
  assert.equal(store.check(scope(), "2026-01-01T00:10:00Z", observation).state, "ABSENT");
  assert.equal(store.check(scope({ tenantId: "tenant-b" }), "2026-01-01T00:10:00Z", observation).decision, "REJECT");
  assert.equal(store.check(scope(), "2026-01-01T00:10:00Z", { entityPresent: true }).state, "STALE");
  assert.equal(store.check(scope(), "2025-12-31T23:00:00Z", observation).reason, "INVALID_SCOPE");
  assert.equal(store.check(scope(), "2026-01-01T00:10:00Z").reason, "INVALID_SCOPE");
  assert.equal(store.check(scope(), "2026-01-01T00:10:00Z", { entityPresent: "false" }).reason, "INVALID_SCOPE");
  store.putAbsent({ ...scope({ queryDigest: "q2" }), reason: "no-conflict", observedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T01:00:00Z" });
  assert.equal(store.stats().entries, 1);
  assert.equal(store.check(scope(), "2026-01-01T00:10:00Z", observation).state, "UNKNOWN");
  assert.equal(store.stats().evictions, 1);
  assert.equal(store.invalidateOnAppearance({ tenantId: "tenant-a", resource: "inventory", incarnationId: "i2" }), 1);
});

test("predicate dependency preserves a claim across irrelevant version changes", () => {
  const dependency = createPredicateDependency({ tenantId: "t", resourceId: "stock", incarnationId: "i", aspect: "available", predicate: { operator: "gte", value: 5 } });
  assert.equal(classifyPredicateChange(dependency, 100, 99), "PRESERVED");
  assert.equal(classifyPredicateChange(dependency, 99, 4), "INVALIDATED");
  assert.equal(classifyPredicateChange(dependency, 4, 99), "UNKNOWN");
  assert.equal(classifyPredicateChange(createPredicateDependency({ tenantId: "t", resourceId: "stock", incarnationId: "i", aspect: "status", predicate: { operator: "neq", value: "deleted" } }), undefined, "ready"), "UNKNOWN");
  assert.equal(createPredicateDependency({ tenantId: "t", resourceId: "stock", incarnationId: "i", aspect: "exists", predicate: { operator: "exists" } }).predicate.operator, "exists");
  assert.equal(classifyPredicateChange({ ...dependency, semanticFingerprint: "sha256:tampered" }, 100, 99), "UNKNOWN");
});

const receiptScope = (extra = {}) => ({ tenantId: "t", resourceId: "r", incarnationId: "i", versionScheme: "etag", versionToken: "v", validatorId: "val", authorizationContextDigest: "auth", policyDigest: "policy", changeSetDigest: null, queryFamily: "inventory", queryParts: ["sku", "stock"], scopes: ["/sku", "/stock"], causalFrontier: ["e1", "e2"], ...extra });
const receipt = (extra = {}) => ({ receiptId: "z", scope: receiptScope(), observedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T01:00:00Z", value: { ok: true }, ...extra });
const requirement = (extra = {}) => ({ scope: receiptScope(), requiredQueryParts: ["stock"], requiredScopes: ["/stock"], requiredFrontier: ["e1"], now: "2026-01-01T00:10:00Z", ...extra });

test("receipt subsumption requires exact safety scope and only relaxes query coverage", () => {
  assert.equal(assessReceiptSubsumption(receipt(), requirement()).eligible, true);
  assert.equal(assessReceiptSubsumption(receipt({ scope: receiptScope({ tenantId: "other" }) }), requirement()).reason, "TENANT_MISMATCH");
  assert.equal(assessReceiptSubsumption(receipt({ scope: receiptScope({ versionToken: "old" }) }), requirement()).reason, "VERSION_MISMATCH");
  assert.equal(assessReceiptSubsumption(receipt({ scope: receiptScope({ versionScheme: "commit" }) }), requirement()).reason, "VERSION_SCHEME_MISMATCH");
  assert.equal(assessReceiptSubsumption(receipt({ scope: receiptScope({ changeSetDigest: "changes:1" }) }), requirement()).reason, "CHANGE_SET_MISMATCH");
  assert.equal(assessReceiptSubsumption(receipt({ scope: receiptScope({ queryParts: ["sku"] }) }), requirement()).reason, "QUERY_INSUFFICIENT");
  assert.equal(selectSubsumingReceipt([receipt({ receiptId: "b" }), receipt({ receiptId: "a" })], requirement()).receipt?.receiptId, "a");
  assert.equal(assessReceiptSubsumption(receipt({ observedAt: "2026-01-01T02:00:00Z", expiresAt: "2026-01-01T03:00:00Z" }), requirement()).reason, "INVALID");
  assert.equal(assessReceiptSubsumption(receipt({ scope: receiptScope({ tenantId: "" }) }), requirement()).reason, "INVALID");
  assert.equal(assessReceiptSubsumption(receipt({ scope: receiptScope({ causalFrontier: ["e1"] }) }), requirement()).reason, "FRONTIER_INSUFFICIENT");
});
