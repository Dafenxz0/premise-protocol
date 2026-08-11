import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  MemoryV2SignatureReplayStore,
  SPEC_VERSION_V2,
  V2EnvelopeValidationError,
  classifyIdempotency,
  canonicalizeMemoryEnvelopeV2,
  canonicalizeMemoryEnvelopeV2Signature,
  isMemoryEnvelopeV2,
  isV2Event,
  isV2OperationRequest,
  migrateV1Envelope,
  parseAndVerifyMemoryEnvelopeV2,
  parseAndVerifyMemoryEnvelopeV2Async,
  parseMemoryEnvelopeV2,
  verifyMemoryEnvelopeV2,
  verifyMemoryEnvelopeV2SignaturesAsync,
  verifyMemoryEnvelopeV2Signatures,
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

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const unsigned = { ...structuredClone(valid), signatures: [] };
const signatureMetadata = { signatureId: "sig:real", signerId: "agent:1", keyId: "key:ed25519", algorithm: "ed25519", signedAt: at, evidenceId: "e:pr" };
const signatureValue = sign(null, Buffer.from(canonicalizeMemoryEnvelopeV2Signature(unsigned, signatureMetadata), "utf8"), privateKey).toString("base64");
const signedEnvelope = { ...unsigned, signatures: [{ ...signatureMetadata, value: signatureValue }] };
const replayStore = new MemoryV2SignatureReplayStore();
assert.equal(canonicalizeMemoryEnvelopeV2({ ...signedEnvelope, signatures: [{ ...signedEnvelope.signatures[0], value: "different" }] }), canonicalizeMemoryEnvelopeV2(signedEnvelope));
assert.equal(verifyMemoryEnvelopeV2Signatures(signedEnvelope, { keys: new Map([["key:ed25519", publicKey]]), replayStore }).verified, true);
assert.equal(verifyMemoryEnvelopeV2(signedEnvelope, { keys: new Map([["key:ed25519", publicKey]]), replayStore }), false, "the same signature must be rejected as replay");
assert.equal(parseAndVerifyMemoryEnvelopeV2({ ...unsigned, signatures: [{ ...signatureMetadata, value: signatureValue }] }, { keys: new Map([["key:ed25519", publicKey]]), replayStore: new MemoryV2SignatureReplayStore() }).memoryId, valid.memoryId);
assert.equal(verifyMemoryEnvelopeV2({ ...signedEnvelope, memoryId: "memory:tampered" }, { keys: new Map([["key:ed25519", publicKey]]), replayStore: new MemoryV2SignatureReplayStore() }), false, "tampering must fail cryptographic verification");
assert.equal(verifyMemoryEnvelopeV2({ ...signedEnvelope, signatures: [{ ...signedEnvelope.signatures[0], signedAt: new Date().toISOString() }] }, { keys: new Map([["key:ed25519", publicKey]]), replayStore: new MemoryV2SignatureReplayStore() }), false, "signature metadata tampering must fail cryptographic verification");
const invalidAlgorithm = { ...signedEnvelope, signatures: [{ ...signedEnvelope.signatures[0], algorithm: "rsa-sha256" }] };
assert.equal(validateMemoryEnvelopeV2(invalidAlgorithm).some(({ path }) => path === "$.signatures[0].algorithm"), true);
assert.equal(verifyMemoryEnvelopeV2Signatures(invalidAlgorithm, { keys: new Map([["key:ed25519", publicKey]]), replayStore: new MemoryV2SignatureReplayStore() }).verified, false, "unsupported algorithms must be rejected");
assert.equal(verifyMemoryEnvelopeV2Signatures(signedEnvelope, { keys: new Map([["key:other", publicKey]]), replayStore: new MemoryV2SignatureReplayStore() }).verified, false, "unknown keyIds must be rejected");
assert.equal(verifyMemoryEnvelopeV2Signatures({ ...signedEnvelope, signatures: [{ ...signedEnvelope.signatures[0], value: "not-base64" }] }, { keys: new Map([["key:ed25519", publicKey]]), replayStore: new MemoryV2SignatureReplayStore() }).verified, false, "invalid signature encoding must be rejected");
assert.equal(verifyMemoryEnvelopeV2({ ...unsigned, signatures: [] }, { keys: new Map([["key:ed25519", publicKey]]), replayStore: new MemoryV2SignatureReplayStore() }), false, "unsigned envelopes must be rejected by the crypto verifier");

const asyncAt = new Date().toISOString();
const asyncSignatureMetadata = { signatureId: "sig:async", signerId: "agent:async", keyId: "key:ed25519", algorithm: "ed25519", signedAt: asyncAt, evidenceId: "e:pr" };
const asyncSignatureValue = sign(null, Buffer.from(canonicalizeMemoryEnvelopeV2Signature(unsigned, asyncSignatureMetadata), "utf8"), privateKey).toString("base64");
const asyncSignedEnvelope = { ...unsigned, signatures: [{ ...asyncSignatureMetadata, value: asyncSignatureValue }] };
const durableReplay = {
  claims: [],
  accepted: new Set(),
  async claim(claim) {
    this.claims.push(claim);
    if (this.accepted.has(claim.key)) return false;
    this.accepted.add(claim.key);
    return true;
  },
  async claimMany(claims) {
    this.claims.push(...claims);
    if (claims.some((claim) => this.accepted.has(claim.key)) || new Set(claims.map((claim) => claim.key)).size !== claims.length) return false;
    for (const claim of claims) this.accepted.add(claim.key);
    return true;
  }
};
assert.equal((await verifyMemoryEnvelopeV2SignaturesAsync(asyncSignedEnvelope, { keys: new Map([["key:ed25519", publicKey]]), replayStore: durableReplay, now: () => asyncAt })).verified, true);
assert.equal(durableReplay.claims[0].tenantId, unsigned.tenantId, "durable replay claims must be tenant scoped");
assert.equal((await verifyMemoryEnvelopeV2SignaturesAsync(asyncSignedEnvelope, { keys: new Map([["key:ed25519", publicKey]]), replayStore: durableReplay, now: () => asyncAt })).verified, false, "durable replay must reject a signature after restart-equivalent state reuse");
assert.equal((await verifyMemoryEnvelopeV2SignaturesAsync(asyncSignedEnvelope, { keys: new Map([["key:ed25519", publicKey]]), replayStore: { claim: async () => true, claimMany: async () => { throw new Error("database unavailable"); } }, now: () => asyncAt })).issues[0].code, "REPLAY_STORE_UNAVAILABLE");
const staleAsync = { ...asyncSignedEnvelope, signatures: [{ ...asyncSignedEnvelope.signatures[0], signedAt: "2020-01-01T00:00:00.000Z" }] };
assert.equal((await verifyMemoryEnvelopeV2SignaturesAsync(staleAsync, { keys: new Map([["key:ed25519", publicKey]]), replayStore: { claim: async () => true, claimMany: async () => true }, now: () => asyncAt, maxClockSkewMs: 1_000 })).issues[0].code, "SIGNATURE_TIME_INVALID");
assert.equal((await parseAndVerifyMemoryEnvelopeV2Async(asyncSignedEnvelope, { keys: new Map([["key:ed25519", publicKey]]), replayStore: { claim: async () => true, claimMany: async () => true }, now: () => asyncAt })).memoryId, valid.memoryId);

console.log("protocol-types v2 contract tests passed");
