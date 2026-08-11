import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  AUDIT_GENESIS_HASH,
  AclPolicy,
  AuditLog,
  KeyRing,
  MemoryReplayStore,
  ReplayGuard,
  WebhookVerifier,
  canonicalize,
  decryptPayload,
  encryptPayload,
  generateAes256Key,
  generateEd25519KeyPair,
  isEncryptedPayload,
  sanitizeSecrets,
  signEd25519,
  signWebhook,
  signWebhookRequest,
  verifyAuditChain,
  verifyEd25519,
  verifyWebhookRequest,
  verifyWebhookSignature
} from "../dist/index.js";

const fixedBytes = (value) => Uint8Array.from({ length: 32 }, (_, index) => (value + index) & 0xff);
const keys = generateEd25519KeyPair();
const signed = { tenantId: "tenant:acme", action: "memory.read", payload: { id: "m-1", value: 7 } };
const signature = signEd25519(signed, keys.privateKey);
assert.equal(verifyEd25519(signed, signature, keys.publicKey), true);
assert.equal(verifyEd25519({ ...signed, payload: { ...signed.payload, value: 8 } }, signature, keys.publicKey), false, "signed tampering must fail");
assert.equal(verifyEd25519(signed, `${signature.slice(0, -2)}aa`, keys.publicKey), false, "invalid signature must fail");
const rsaKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
assert.throws(() => signEd25519(signed, rsaKeys.privateKey), (error) => error?.code === "SIGNING_FAILED", "RSA private keys must not enter the Ed25519 signer");
assert.equal(verifyEd25519(signed, signature, rsaKeys.publicKey), false, "RSA public keys must not enter the Ed25519 verifier");
assert.equal(canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}');

const body = JSON.stringify({ event: "memory.updated", value: 3 });
const webhookSecret = "webhook-secret-for-tests";
const webhookSignature = signWebhook(body, webhookSecret);
assert.equal(verifyWebhookSignature(body, webhookSignature, webhookSecret), true);
assert.equal(verifyWebhookSignature(`${body} `, webhookSignature, webhookSecret), false, "webhook tampering must fail");
assert.equal(verifyWebhookSignature(body, signWebhook(body, "wrong-secret"), webhookSecret), false);
const requestMetadata = { deliveryId: "delivery-1", timestamp: "2026-08-10T10:00:00.000Z" };
const requestSignature = signWebhookRequest(body, webhookSecret, requestMetadata);
assert.equal(verifyWebhookRequest(body, requestSignature, webhookSecret, requestMetadata), true);
assert.equal(verifyWebhookRequest(body, requestSignature, webhookSecret, { ...requestMetadata, deliveryId: "delivery-2" }), false);

let now = Date.parse("2026-08-10T10:00:00.000Z");
const replayGuard = new ReplayGuard({ now: () => now, ttlMs: 10_000, maxClockSkewMs: 2_000, store: new MemoryReplayStore() });
const verifier = new WebhookVerifier({ secret: webhookSecret, replayGuard, bindMetadata: true });
const verifiedRequest = { payload: body, signature: requestSignature, ...requestMetadata };
assert.equal(verifier.verify(verifiedRequest), true);
assert.equal(verifier.verify(verifiedRequest), false, "the same delivery must be rejected as replay");
const secondMetadata = { deliveryId: "delivery-2", timestamp: requestMetadata.timestamp };
const secondRequest = { payload: body + "2", signature: signWebhookRequest(body + "2", webhookSecret, secondMetadata), ...secondMetadata };
assert.equal(verifier.verify(secondRequest), true);
now += 10_000;
const staleMetadata = { deliveryId: "delivery-3", timestamp: requestMetadata.timestamp };
const staleRequest = { payload: body + "3", signature: signWebhookRequest(body + "3", webhookSecret, staleMetadata), ...staleMetadata };
assert.equal(verifier.verify(staleRequest), false, "stale webhook must be rejected");

let ivCounter = 0;
const deterministicIv = (size) => Uint8Array.from({ length: size }, () => ++ivCounter);
const aad = "tenant:acme";
const encrypted = encryptPayload({ tenantId: aad, secret: "do-not-log" }, { keyId: "k-1", key: fixedBytes(1), aad, randomBytes: deterministicIv });
assert.equal(isEncryptedPayload(encrypted), true);
assert.deepEqual(decryptPayload(encrypted, { key: fixedBytes(1), expectedAssociatedData: aad }), { tenantId: aad, secret: "do-not-log" });
const tamperedCiphertext = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -4)}AAAA` };
assert.throws(() => decryptPayload(tamperedCiphertext, { key: fixedBytes(1), expectedAssociatedData: aad }), /Payload authentication failed/);
assert.throws(() => decryptPayload(encrypted, { key: fixedBytes(2), expectedAssociatedData: aad }), /Payload authentication failed/);
assert.throws(() => decryptPayload(encrypted, { key: fixedBytes(1), expectedAssociatedData: "tenant:other" }), /Payload authentication failed/);
assert.equal(generateAes256Key().length, 32);

let ringIv = 0;
const ring = new KeyRing({ activeKey: { keyId: "key-v1", key: fixedBytes(10) }, randomBytes: (size) => Uint8Array.from({ length: size }, () => ++ringIv) });
const oldPayload = ring.encrypt({ version: 1 }, { associatedData: aad });
ring.rotate({ keyId: "key-v2", key: fixedBytes(20) });
const newPayload = ring.encrypt({ version: 2 }, { associatedData: aad });
assert.equal(oldPayload.keyId, "key-v1");
assert.equal(newPayload.keyId, "key-v2");
assert.deepEqual(ring.decrypt(oldPayload, { expectedAssociatedData: aad }), { version: 1 }, "rotated rings must decrypt retained old keys");
assert.deepEqual(ring.decrypt(newPayload, { expectedAssociatedData: aad }), { version: 2 });
ring.retire("key-v1");
assert.throws(() => ring.decrypt(oldPayload, { expectedAssociatedData: aad }), /Payload authentication failed/);

const acl = new AclPolicy([
  { effect: "allow", tenantId: "tenant:acme", subjectId: "subject:alice", action: "memory.read", resource: "memory:1" },
  { effect: "deny", tenantId: "tenant:acme", subjectId: "subject:alice", action: "memory.delete" },
  { effect: "allow", tenantId: "tenant:acme", subjectId: "*", action: "memory.read" }
]);
assert.equal(acl.isAllowed({ tenantId: "tenant:acme", subjectId: "subject:alice", action: "memory.read", resource: "memory:1" }), true);
assert.equal(acl.isAllowed({ tenantId: "tenant:other", subjectId: "subject:alice", action: "memory.read", resource: "memory:1" }), false, "tenant isolation must deny cross-tenant access");
assert.equal(acl.isAllowed({ tenantId: "tenant:acme", subjectId: "subject:alice", action: "memory.delete" }), false);
assert.throws(() => acl.assertAuthorized({ tenantId: "tenant:other", subjectId: "subject:alice", action: "memory.read" }), /Access denied/);

const secrets = { token: "token-value", nested: { password: "password-value" }, message: "request contained token-value" };
const sanitized = sanitizeSecrets(secrets, { secrets: ["token-value", "password-value"] });
assert.deepEqual(sanitized, { token: "[REDACTED]", nested: { password: "[REDACTED]" }, message: "request contained [REDACTED]" });
const audit = new AuditLog({
  now: () => "2026-08-10T10:00:00.000Z",
  eventIdGenerator: (() => { let id = 0; return () => `audit-${++id}`; })(),
  secrets: [webhookSecret]
});
const first = audit.append({ tenantId: "tenant:acme", subjectId: "subject:alice", action: "memory.read", outcome: "allow", data: { authorization: webhookSecret, result: "ok" } });
const second = audit.append({ tenantId: "tenant:acme", subjectId: "subject:alice", action: "memory.write", outcome: "success", data: { result: "stored" } });
assert.equal(first.previousHash, AUDIT_GENESIS_HASH);
assert.equal(second.previousHash, first.hash);
assert.equal(audit.verify(), true);
assert.equal(verifyAuditChain(audit.entries()), true);
assert.equal(first.data.authorization, "[REDACTED]");
const tamperedAudit = audit.entries().map((entry) => entry === second ? { ...entry, data: { result: "tampered" } } : entry);
assert.equal(verifyAuditChain(tamperedAudit), false, "audit tampering must break the hash chain");
assert.equal(JSON.stringify(audit.entries()).includes(webhookSecret), false, "audit entries must not contain secrets");
const { hash: _validHash, ...malformedUnsigned } = first;
const malformedHash = `sha256:${createHash("sha256").update(canonicalize({ ...malformedUnsigned, unexpected: true })).digest("hex")}`;
assert.equal(verifyAuditChain([{ ...malformedUnsigned, unexpected: true, hash: malformedHash }]), false, "audit verification must reject fields outside the signed schema");

console.log("security-core deterministic security tests passed");
