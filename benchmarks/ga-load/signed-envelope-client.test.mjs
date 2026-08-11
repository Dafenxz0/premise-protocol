import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalizeMemoryEnvelopeV2Signature, MemoryV2SignatureReplayStore, verifyMemoryEnvelopeV2Signatures } from "../../packages/protocol-types/dist/index.js";
import { loadSignedEnvelopeClient } from "./signed-envelope-client.mjs";

const at = new Date().toISOString();
const unsigned = {
  specVersion: "premise/2",
  tenantId: "tenant:benchmark",
  memoryId: "memory:benchmark:1",
  evidence: [{ evidenceId: "evidence:benchmark:1", sourceUri: "memory://benchmark/1", observedAt: at }],
  confidence: { score: null, method: "benchmark", assessedAt: at },
  conflicts: [],
  temporal: { asOf: at },
  validity: { status: "FRESH", checkedAt: at, policy: "MANUAL" },
  dependsOn: [],
  signatures: []
};

test("benchmark client binds envelope and signature metadata with Ed25519", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const file = path.join(tmpdir(), `premise-signing-${process.pid}.pem`);
  await writeFile(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const client = await loadSignedEnvelopeClient({ privateKeyFile: file, keyId: "key:test-client", signerId: "agent:test-client", required: true });
  const signed = client.signEnvelope(unsigned, { signatureId: "sig:test-client", evidenceId: "evidence:benchmark:1" });
  const result = verifyMemoryEnvelopeV2Signatures(signed, { keys: new Map([["key:test-client", publicKey]]), replayStore: new MemoryV2SignatureReplayStore() });
  assert.equal(result.verified, true);
  assert.equal(signed.signatures[0].keyId, "key:test-client");
  assert.notEqual(canonicalizeMemoryEnvelopeV2Signature(unsigned, signed.signatures[0]), "");
});

test("required production client fails closed without private material", async () => {
  await assert.rejects(() => loadSignedEnvelopeClient({ privateKeyFile: undefined, privateKeyPem: undefined, required: true }), /requires/u);
});

console.log("signed benchmark client tests passed");
