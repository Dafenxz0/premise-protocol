import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { PremiseRuntime } from "@premise/runtime-core";
import { canonicalizeMemoryEnvelopeV2Signature, parseAndVerifyMemoryEnvelopeV2Async } from "@premise/protocol-types";
import { PremiseServer } from "../dist/v2.js";

const tenantId = "tenant:signature-http";
const at = new Date().toISOString();
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const replayStore = {
  keys: new Set(),
  unavailable: false,
  async claim() { return false; },
  async claimMany(claims) {
    if (this.unavailable) throw new Error("replay database unavailable");
    if (claims.some((claim) => this.keys.has(claim.key)) || new Set(claims.map((claim) => claim.key)).size !== claims.length) return false;
    for (const claim of claims) this.keys.add(claim.key);
    return true;
  }
};

function baseEnvelope(memoryId) {
  return {
    specVersion: "premise/2",
    tenantId,
    memoryId,
    evidence: [{ evidenceId: `evidence:${memoryId}`, sourceUri: `memory://${memoryId}`, observedAt: at }],
    confidence: { score: null, method: "signature-http-test", assessedAt: at },
    conflicts: [],
    temporal: { asOf: at },
    validity: { status: "FRESH", checkedAt: at, policy: "MANUAL" },
    dependsOn: [],
    signatures: []
  };
}

function signedEnvelope(memoryId, metadataPatch = {}) {
  const unsigned = baseEnvelope(memoryId);
  const metadata = {
    signatureId: `signature:${memoryId}`,
    signerId: "test-signer",
    keyId: "key:http-test",
    algorithm: "ed25519",
    signedAt: at,
    ...metadataPatch
  };
  const value = sign(null, Buffer.from(canonicalizeMemoryEnvelopeV2Signature(unsigned, metadata), "utf8"), privateKey).toString("base64");
  return { ...unsigned, signatures: [{ ...metadata, value }] };
}

const runtime = new PremiseRuntime({ tenantId, now: () => at });
const server = new PremiseServer({
  runtime,
  verifyEnvelope: (input) => parseAndVerifyMemoryEnvelopeV2Async(input, {
    keys: new Map([["key:http-test", publicKey]]),
    replayStore,
    now: () => at
  })
});
await server.listen({ host: "127.0.0.1", port: 0 });
const address = server.server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function register(envelope, idempotencyKey) {
  const response = await fetch(`${baseUrl}/v2/memories`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ record: { envelope, content: envelope.memoryId } })
  });
  return { status: response.status, body: await response.json() };
}

assert.equal((await register(signedEnvelope("memory:signed"), "signature-http-1")).status, 201);
assert.equal((await register(signedEnvelope("memory:replay"), "signature-http-2")).status, 201);
const replay = await register(signedEnvelope("memory:signed"), "signature-http-3");
assert.equal(replay.status, 422);
assert.equal(replay.body.error, "SIGNATURE_INVALID");

const metadataTampered = signedEnvelope("memory:tampered", { signerId: "different-signer" });
metadataTampered.signatures[0].signerId = "attacker";
const tampered = await register(metadataTampered, "signature-http-4");
assert.equal(tampered.status, 422);
assert.equal(tampered.body.error, "SIGNATURE_INVALID");

replayStore.unavailable = true;
const unavailable = await register(signedEnvelope("memory:unavailable"), "signature-http-5");
assert.equal(unavailable.status, 503);
assert.equal(unavailable.body.error, "SIGNATURE_REPLAY_UNAVAILABLE");

await server.close();
console.log("premise-server signature HTTP tests passed");
