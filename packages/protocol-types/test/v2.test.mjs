import assert from "node:assert/strict";
import {
  SPEC_VERSION_V2,
  V2EnvelopeValidationError,
  classifyIdempotency,
  isMemoryEnvelopeV2,
  isV2Event,
  isV2OperationRequest,
  migrateV1Envelope,
  parseMemoryEnvelopeV2,
  validateMemoryEnvelopeV2
} from "../dist/index.js";

const at = "2026-08-09T19:20:00Z";
const later = "2026-08-10T19:20:00Z";
const digest = "sha256:abc123";

const valid = {
  specVersion: SPEC_VERSION_V2,
  tenantId: "tenant:acme",
  memoryId: "memory:decision",
  contentDigest: digest,
  evidence: [
    { evidenceId: "e:pr", sourceUri: "github://acme/pr/42", observedAt: at, version: { scheme: "git", token: "abc" }, validator: { id: "github", operation: "pull-request" }, confidence: { score: 0.9, method: "validator", assessedAt: at } },
    { evidenceId: "e:ci", sourceUri: "ci://acme/pr/42", observedAt: at, confidence: { score: 0.8, method: "ci", assessedAt: at } }
  ],
  confidence: { score: 0.86, method: "weighted-evidence", assessedAt: at },
  conflicts: [
    { conflictId: "c:resolved", evidenceIds: ["e:pr", "e:ci"], status: "RESOLVED", resolution: { strategy: "PREFER_CONFIDENCE", resolvedAt: later, selectedEvidenceId: "e:pr" } }
  ],
  temporal: { asOf: at, validFrom: at, validUntil: later },
  validity: { status: "FRESH", checkedAt: at, policy: "TTL", expiresAt: later },
  dependsOn: [],
  signatures: [{ signatureId: "sig:1", signerId: "agent:1", keyId: "key:1", algorithm: "ed25519", value: "opaque-signature", signedAt: at, evidenceId: "e:pr" }]
};

assert.equal(validateMemoryEnvelopeV2(valid).length, 0);
assert.equal(isMemoryEnvelopeV2(valid), true);
assert.equal(parseMemoryEnvelopeV2(valid).tenantId, "tenant:acme");

const openConflict = structuredClone(valid);
openConflict.validity = { status: "FRESH", checkedAt: at, policy: "MANUAL" };
openConflict.conflicts = [{ conflictId: "c:open", evidenceIds: ["e:pr", "e:ci"], status: "OPEN" }];
assert.equal(validateMemoryEnvelopeV2(openConflict).some(({ path }) => path === "$.validity.status"), true);

const badTemporal = structuredClone(valid);
badTemporal.temporal = { asOf: at, validFrom: later, validUntil: at };
assert.equal(validateMemoryEnvelopeV2(badTemporal).some(({ path }) => path === "$.temporal"), true);

const badSignature = structuredClone(valid);
badSignature.signatures[0].evidenceId = "e:missing";
assert.equal(validateMemoryEnvelopeV2(badSignature).some(({ path }) => path === "$.signatures[0].evidenceId"), true);

const request = {
  specVersion: SPEC_VERSION_V2,
  tenantId: "tenant:acme",
  operationId: "op:1",
  operation: "register",
  idempotencyKey: "idem:1",
  requestDigest: digest,
  requestedAt: at,
  payload: { envelope: valid }
};
assert.equal(isV2OperationRequest(request), true);
assert.equal(classifyIdempotency(request), "NEW");
assert.equal(classifyIdempotency(request, request), "REPLAY");
assert.equal(classifyIdempotency({ ...request, requestDigest: "sha256:different" }, request), "CONFLICT");
assert.equal(classifyIdempotency({ ...request, tenantId: "tenant:other" }, request), "NEW");

const event = {
  specVersion: SPEC_VERSION_V2,
  tenantId: "tenant:acme",
  eventId: "event:1",
  operationId: request.operationId,
  idempotencyKey: request.idempotencyKey,
  requestDigest: request.requestDigest,
  type: "MemoryRegistered",
  occurredAt: at,
  memoryId: valid.memoryId,
  payload: { envelope: valid }
};
assert.equal(isV2Event(event), true);
assert.equal(isV2Event({ ...event, tenantId: " tenant:wrong" }), false);

const v1 = {
  specVersion: "premise/0.1",
  memoryId: "memory:v1",
  contentDigest: digest,
  provenance: [{ sourceUri: "file:///fact", observedAt: at, version: { scheme: "file", token: "v1" }, validator: { id: "fs", operation: "stat" } }],
  validity: { status: "FRESH", checkedAt: at, policy: "TTL", expiresAt: later },
  dependsOn: ["memory:base"]
};
const migrated = migrateV1Envelope(v1, { tenantId: "tenant:acme" });
assert.equal(migrated.specVersion, SPEC_VERSION_V2);
assert.equal(migrated.tenantId, "tenant:acme");
assert.deepEqual(migrated.dependsOn, ["memory:base"]);
assert.equal(migrated.evidence[0].sourceUri, "file:///fact");
assert.equal(migrated.evidence[0].version.token, "v1");
assert.equal(migrated.confidence.score, null);
assert.equal(migrated.temporal.validUntil, later);
assert.equal(isMemoryEnvelopeV2(migrated), true);

assert.throws(() => parseMemoryEnvelopeV2({ ...valid, tenantId: "" }), V2EnvelopeValidationError);
assert.throws(() => migrateV1Envelope(v1, { tenantId: "" }), V2EnvelopeValidationError);
assert.throws(() => migrateV1Envelope({ ...v1, specVersion: SPEC_VERSION_V2 }, { tenantId: "tenant:acme" }), V2EnvelopeValidationError);

console.log("protocol-types v2 contract tests passed");
