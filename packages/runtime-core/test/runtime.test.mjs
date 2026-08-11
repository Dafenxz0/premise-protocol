import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { InMemoryRuntimeStore, PremiseRuntime } from "../dist/index.js";
import { canonicalizeMemoryEnvelopeV2Signature, MemoryV2SignatureReplayStore } from "@premise/protocol-types";

const at = "2026-08-10T10:00:00Z";
const envelope = (memoryId, dependsOn = [], status = "FRESH", tenantId = "tenant:acme", sourceUri = "github://acme/repo/commit/main") => ({
  specVersion: "premise/2",
  tenantId,
  memoryId,
  evidence: dependsOn.length === 0 ? [{ evidenceId: `${memoryId}:e`, sourceUri, observedAt: at, version: { scheme: "github.commit", token: "a1" }, validator: { id: "github", operation: "commit" } }] : [],
  confidence: { score: null, method: "test", assessedAt: at },
  conflicts: [],
  temporal: { asOf: at },
  validity: { status, checkedAt: at, policy: "MANUAL" },
  dependsOn,
  signatures: []
});

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signedEnvelope = (memoryId) => {
  const unsigned = envelope(memoryId);
  const metadata = { signatureId: `sig:${memoryId}`, signerId: "test-signer", keyId: "key:test", algorithm: "ed25519", signedAt: at };
  const signature = sign(null, Buffer.from(canonicalizeMemoryEnvelopeV2Signature(unsigned, metadata), "utf8"), privateKey).toString("base64");
  return { ...unsigned, signatures: [{ ...metadata, value: signature }] };
};

class CountingStore extends InMemoryRuntimeStore {
  putCalls = 0;
  eventCalls = 0;

  put(record) {
    this.putCalls += 1;
    return super.put(record);
  }

  appendEvent(event) {
    this.eventCalls += 1;
    return super.appendEvent(event);
  }
}

const runtime = new PremiseRuntime({ tenantId: "tenant:acme", now: () => at });
runtime.register({ envelope: envelope("memory:source"), content: { value: "source" } });
runtime.derive({ envelope: envelope("memory:derived", ["memory:source"]), content: { value: "derived" } });
assert.deepEqual(runtime.check(["memory:source", "memory:derived"]).map((item) => item.decision), ["USABLE", "USABLE"]);

const affected = runtime.signalSourceChanged("github://acme/repo/commit/main", { scheme: "github.commit", token: "b2" });
assert.deepEqual(affected, ["memory:source", "memory:derived"]);
assert.deepEqual(runtime.check(["memory:source", "memory:derived"]).map((item) => item.status), ["STALE", "STALE"]);
assert.deepEqual(runtime.history().map((item) => item.type), ["MemoryRegistered", "MemoryDerived", "SourceChanged", "MemoryStaled", "MemoryStaled"]);
assert.equal(runtime.eventCount(), runtime.history().length);

const report = await runtime.revalidate("memory:source", async (evidence) => ({ memoryId: "memory:source", evidenceId: evidence.evidenceId, result: "UNCHANGED", status: "FRESH", checkedAt: at, sourceUri: evidence.sourceUri, version: { scheme: "github.commit", token: "b2" } }));
assert.equal(report.status, "FRESH");
assert.equal(runtime.get("memory:source").content.value, "source");

const event = runtime.history("memory:source")[0];
assert.ok(event);
assert.match(event.requestDigest, /^sha256:v2:[0-9a-f]{64}$/u);
assert.equal(runtime.applyEvent(event), false);
assert.throws(() => runtime.register({ envelope: envelope("memory:source"), content: {} }), /already registered/);
assert.equal(runtime.get("memory:other", { tenantId: "tenant:other" }), undefined);

const idempotent = new PremiseRuntime({ tenantId: "tenant:acme", now: () => at });
const idempotentEnvelope = envelope("memory:idempotent");
idempotent.register({ envelope: idempotentEnvelope, content: { value: "first" } }, "request:register:idempotent");
idempotent.replace("memory:idempotent", { value: "second" }, envelope("memory:idempotent", [], "FRESH", "tenant:acme", "github://acme/repo/second"), "request:replace:idempotent");
assert.throws(
  () => idempotent.replace("memory:idempotent", { value: "third" }, envelope("memory:idempotent", [], "FRESH", "tenant:acme", "github://acme/repo/third"), "request:replace:idempotent"),
  /Conflicting idempotency key/
);
assert.equal(idempotent.get("memory:idempotent").content.value, "second", "a conflicting idempotency key must not overwrite the first request");

const snapshot = runtime.snapshot();
const restored = new PremiseRuntime({ store: new InMemoryRuntimeStore(), tenantId: "tenant:acme", now: () => at });
restored.restore(snapshot);
assert.equal(restored.get("memory:derived").content.value, "derived");
assert.equal(restored.history().length, runtime.history().length);
assert.deepEqual(restored.signalSourceChanged("github://acme/repo/commit/main", { scheme: "github.commit", token: "b3" }), ["memory:source", "memory:derived"], "restore must rebuild source and dependency indexes");

const countedStore = new CountingStore();
const counted = new PremiseRuntime({ store: countedStore, tenantId: "tenant:acme", now: () => at });
counted.register({ envelope: envelope("memory:counted-source"), content: { value: "source" } });
counted.derive({ envelope: envelope("memory:counted-derived", ["memory:counted-source"]), content: { value: "derived" } });
const putsBeforeSignal = countedStore.putCalls;
const eventsBeforeSignal = countedStore.eventCalls;
const firstSignal = counted.signalSourceChanged("github://acme/repo/commit/main", { scheme: "github.commit", token: "b2" });
assert.deepEqual(firstSignal, ["memory:counted-source", "memory:counted-derived"]);
assert.equal(countedStore.putCalls, putsBeforeSignal + 2);
assert.equal(countedStore.eventCalls, eventsBeforeSignal + 3);
const putsAfterFirstSignal = countedStore.putCalls;
const eventsAfterFirstSignal = countedStore.eventCalls;
assert.deepEqual(counted.signalSourceChanged("github://acme/repo/commit/main", { scheme: "github.commit", token: "b2" }), firstSignal);
assert.equal(countedStore.putCalls, putsAfterFirstSignal, "replaying the same source change must not rewrite STALE records");
assert.equal(countedStore.eventCalls, eventsAfterFirstSignal, "replaying the same source change must not append duplicate events");
assert.deepEqual(counted.signalSourceChanged("github://acme/repo/commit/main", { scheme: "github.commit", token: "b3" }), firstSignal);
assert.equal(countedStore.putCalls, putsAfterFirstSignal, "a newer source version must also avoid rewriting records already STALE");
assert.equal(countedStore.eventCalls, eventsAfterFirstSignal + 1, "a newer source version still records its SourceChanged event");
assert.throws(() => counted.signalSourceChanged("", { scheme: "github.commit", token: "b4" }), /non-empty/);

const indexed = new PremiseRuntime({ tenantId: "tenant:acme", now: () => at });
indexed.register({ envelope: envelope("memory:index-source"), content: { value: "source" } });
indexed.register({ envelope: envelope("memory:index-other", [], "FRESH", "tenant:acme", "github://acme/repo/other"), content: { value: "other" } });
indexed.derive({ envelope: envelope("memory:index-derived", ["memory:index-source"]), content: { value: "derived" } });
indexed.replace("memory:index-other", { value: "repointed-source" }, envelope("memory:index-other", [], "FRESH", "tenant:acme", "github://acme/repo/replacement"));
indexed.replace("memory:index-derived", { value: "repointed" }, envelope("memory:index-derived", ["memory:index-other"]));
assert.deepEqual(indexed.signalSourceChanged("github://acme/repo/commit/main", { scheme: "github.commit", token: "c1" }), ["memory:index-source"]);
assert.deepEqual(indexed.signalSourceChanged("github://acme/repo/other", { scheme: "github.commit", token: "c1" }), [], "replace must remove the old source index entry");
assert.deepEqual(indexed.signalSourceChanged("github://acme/repo/replacement", { scheme: "github.commit", token: "c1" }), ["memory:index-other", "memory:index-derived"], "replace must update both source and dependency indexes");

const sharedStore = new InMemoryRuntimeStore();
sharedStore.put({ envelope: envelope("memory:tenant-a-source", [], "FRESH", "tenant:a"), content: { tenant: "a" } });
sharedStore.put({ envelope: envelope("memory:tenant-b-source", [], "FRESH", "tenant:b"), content: { tenant: "b" } });
sharedStore.put({ envelope: envelope("memory:tenant-b-derived", ["memory:tenant-b-source"], "FRESH", "tenant:b"), content: { tenant: "b" } });
const tenantARuntime = new PremiseRuntime({ store: sharedStore, tenantId: "tenant:a", now: () => at });
assert.deepEqual(tenantARuntime.signalSourceChanged("github://acme/repo/commit/main", { scheme: "github.commit", token: "d1" }), ["memory:tenant-a-source"]);
assert.equal(sharedStore.get("memory:tenant-b-source").envelope.validity.status, "FRESH", "source changes must not cross tenant boundaries");
assert.equal(sharedStore.get("memory:tenant-b-derived").envelope.validity.status, "FRESH", "dependency propagation must not cross tenant boundaries");
assert.throws(() => tenantARuntime.derive({ envelope: envelope("memory:cross-tenant", ["memory:tenant-b-source"], "FRESH", "tenant:a"), content: {} }), /Missing required dependency/);

const externallyMutableStore = new InMemoryRuntimeStore();
const externallyMutableRuntime = new PremiseRuntime({ store: externallyMutableStore, tenantId: "tenant:acme", now: () => at });
externallyMutableStore.put({ envelope: envelope("memory:external-source"), content: { value: "external" } });
assert.deepEqual(
  externallyMutableRuntime.signalSourceChanged("github://acme/repo/commit/main", { scheme: "github.commit", token: "e1" }),
  ["memory:external-source"],
  "source indexes must refresh when the public store is mutated outside the runtime"
);

const signatureReplayStore = new MemoryV2SignatureReplayStore();
const signedRuntime = new PremiseRuntime({
  tenantId: "tenant:acme",
  now: () => at,
  signatureVerification: { keys: new Map([["key:test", publicKey]]), replayStore: signatureReplayStore }
});
const trusted = signedEnvelope("memory:signed");
signedRuntime.register({ envelope: trusted, content: { value: "trusted" } }, "request:signed");
signedRuntime.register({ envelope: trusted, content: { value: "trusted" } }, "request:signed");
assert.equal(signedRuntime.history().length, 1, "an idempotent signed retry must not append a second event");
assert.equal(signedRuntime.get("memory:signed").content.value, "trusted");
assert.throws(() => signedRuntime.register({ envelope: envelope("memory:unsigned"), content: {} }), /signature|unsigned/i);
assert.throws(() => new PremiseRuntime({ tenantId: "tenant:acme", requireSignedEnvelopes: true }), /signatureVerification/);
const tampered = { ...signedEnvelope("memory:tampered"), confidence: { ...signedEnvelope("memory:tampered").confidence, method: "tampered" } };
assert.throws(() => signedRuntime.register({ envelope: tampered, content: {} }), /signature|Invalid PREMiSE/);

console.log("runtime-core tests passed");
