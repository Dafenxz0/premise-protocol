import assert from "node:assert/strict";
import {
  AclPolicy,
  AuditLog,
  KeyRing,
  ReplayGuard,
  WebhookVerifier,
  decryptPayload,
  encryptPayload,
  generateEd25519KeyPair,
  signEd25519,
  signWebhook,
  signWebhookRequest,
  verifyAuditChain,
  verifyEd25519,
  verifyWebhookSignature
} from "../packages/security-core/dist/index.js";

const bytes = (seed) => Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff);
const keys = generateEd25519KeyPair();
const signedPayload = { tenantId: "tenant:verify", action: "read", value: 1 };
const ed25519Signature = signEd25519(signedPayload, keys.privateKey);
assert.equal(verifyEd25519(signedPayload, ed25519Signature, keys.publicKey), true);
assert.equal(verifyEd25519({ ...signedPayload, value: 2 }, ed25519Signature, keys.publicKey), false);

const rawBody = '{"event":"updated","id":"memory:1"}';
const secret = "verify-webhook-secret";
const hmac = signWebhook(rawBody, secret);
assert.equal(verifyWebhookSignature(rawBody, hmac, secret), true);
assert.equal(verifyWebhookSignature(`${rawBody}!`, hmac, secret), false);

let clock = Date.parse("2026-08-10T10:00:00.000Z");
const replay = new ReplayGuard({ now: () => clock, ttlMs: 30_000, maxClockSkewMs: 2_000 });
const metadata = { deliveryId: "delivery:1", timestamp: "2026-08-10T10:00:00.000Z" };
const signedRequest = signWebhookRequest(rawBody, secret, metadata);
const verifier = new WebhookVerifier({ secret, replayGuard: replay, bindMetadata: true });
assert.equal(verifier.verify({ payload: rawBody, signature: signedRequest, ...metadata }), true);
assert.equal(verifier.verify({ payload: rawBody, signature: signedRequest, ...metadata }), false);

let iv = 0;
const encrypted = encryptPayload({ tenantId: "tenant:verify", value: "payload" }, {
  keyId: "key:v1",
  key: bytes(1),
  associatedData: "tenant:verify",
  randomBytes: (size) => Uint8Array.from({ length: size }, () => ++iv)
});
assert.deepEqual(decryptPayload(encrypted, { key: bytes(1), expectedAssociatedData: "tenant:verify" }), { tenantId: "tenant:verify", value: "payload" });
assert.throws(() => decryptPayload({ ...encrypted, authTag: encrypted.authTag.slice(0, -4) + "AAAA" }, { key: bytes(1) }), /Payload authentication failed/);

let ringIv = 0;
const ring = new KeyRing({
  activeKey: { keyId: "key:v1", key: bytes(2) },
  randomBytes: (size) => Uint8Array.from({ length: size }, () => ++ringIv)
});
const oldCiphertext = ring.encrypt({ version: 1 });
ring.rotate({ keyId: "key:v2", key: bytes(3) });
assert.equal(ring.encrypt({ version: 2 }).keyId, "key:v2");
assert.deepEqual(ring.decrypt(oldCiphertext), { version: 1 });

const acl = new AclPolicy([{ effect: "allow", tenantId: "tenant:verify", subjectId: "subject:one", action: "memory.read" }]);
assert.equal(acl.authorize({ tenantId: "tenant:verify", subjectId: "subject:one", action: "memory.read" }), true);
assert.equal(acl.authorize({ tenantId: "tenant:other", subjectId: "subject:one", action: "memory.read" }), false);

const audit = new AuditLog({ now: () => "2026-08-10T10:00:00.000Z", eventIdGenerator: (() => { let id = 0; return () => `verify-${++id}`; })(), secrets: [secret] });
audit.append({ tenantId: "tenant:verify", subjectId: "subject:one", action: "webhook.accept", outcome: "success", data: { token: secret, ok: true } });
assert.equal(audit.verify(), true);
assert.equal(verifyAuditChain(audit.entries()), true);
assert.equal(JSON.stringify(audit.entries()).includes(secret), false);

clock += 30_000;
assert.equal(verifier.verify({ payload: rawBody + "-stale", signature: signWebhookRequest(rawBody + "-stale", secret, { deliveryId: "delivery:2", timestamp: metadata.timestamp }), deliveryId: "delivery:2", timestamp: metadata.timestamp }), false);

console.log("PREMiSE security verification passed");
