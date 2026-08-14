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

const sharingScope = (evidence, record) => ({
  tenantId: record.envelope.tenantId,
  resourceId: evidence.sourceUri,
  incarnationId: `inc:${evidence.evidenceId}`,
  versionScheme: evidence.version.scheme,
  versionToken: `${evidence.version.scheme}:${evidence.version.token}`,
  scopes: ["read:source"],
  queryDigest: "query:runtime-test",
  validatorId: evidence.validator.id,
  authorizationContextDigest: "auth:test",
  policyDigest: "policy:runtime-test",
  changeSetDigest: null,
  causalFrontier: []
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
  getCalls = 0;
  getManyCalls = 0;
  casCalls = 0;

  get(memoryId) {
    this.getCalls += 1;
    return super.get(memoryId);
  }

  getMany(memoryIds) {
    this.getManyCalls += 1;
    return super.getMany(memoryIds);
  }

  putAndAppendIfUnchanged(expected, record, event) {
    this.casCalls += 1;
    return super.putAndAppendIfUnchanged(expected, record, event);
  }

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

const batchStore = new CountingStore();
const batch = new PremiseRuntime({ store: batchStore, tenantId: "tenant:acme", now: () => at });
batch.register({ envelope: envelope("memory:batch"), content: {} });
batchStore.getCalls = 0;
batchStore.getManyCalls = 0;
assert.deepEqual(batch.checkMany(["memory:batch", "memory:missing", "memory:batch"]).map((item) => item.memoryId), ["memory:batch", "memory:missing", "memory:batch"]);
assert.equal(batchStore.getManyCalls, 1, "checkMany must use one batch read");
assert.equal(batchStore.getCalls, 0, "checkMany must not fall back when getMany is available");
assert.deepEqual(batch.check(["memory:batch", "memory:missing"]), batch.checkMany(["memory:batch", "memory:missing"]));
batchStore.getCalls = 0;
batchStore.getManyCalls = 0;
assert.equal(batch.retrieve(["memory:batch", "memory:batch"]).length, 1);
assert.equal(batchStore.getManyCalls, 1, "retrieve must use one batch read");
assert.equal(batchStore.getCalls, 0, "retrieve must not fall back when getMany is available");

const fallbackStore = new CountingStore();
fallbackStore.getMany = undefined;
const fallbackRuntime = new PremiseRuntime({ store: fallbackStore, tenantId: "tenant:acme", now: () => at });
fallbackRuntime.register({ envelope: envelope("memory:fallback-read"), content: {} });
fallbackRuntime.register({ envelope: envelope("memory:fallback-read-2"), content: {} });
fallbackStore.getCalls = 0;
assert.deepEqual(fallbackRuntime.checkMany(["memory:fallback-read", "memory:missing", "memory:fallback-read"]).map((item) => item.memoryId), ["memory:fallback-read", "memory:missing", "memory:fallback-read"]);
assert.equal(fallbackStore.getCalls, 2, "checkMany fallback must read each unique memory once");
fallbackStore.getCalls = 0;
assert.deepEqual(fallbackRuntime.retrieve(["memory:fallback-read-2", "memory:fallback-read", "memory:fallback-read-2"]).map((item) => item.envelope.memoryId), ["memory:fallback-read-2", "memory:fallback-read"]);
assert.equal(fallbackStore.getCalls, 2, "retrieve fallback must read each unique memory once");
fallbackStore.getCalls = 0;
fallbackStore.casCalls = 0;
const fallbackReports = await fallbackRuntime.revalidateMany(["memory:fallback-read-2", "memory:fallback-read", "memory:fallback-read-2"], async (evidence) => ({
  memoryId: "ignored-by-batch",
  result: "UNCHANGED",
  status: "FRESH",
  checkedAt: at,
  sourceUri: evidence.sourceUri
}));
assert.deepEqual(fallbackReports.map((item) => item.memoryId), ["memory:fallback-read-2", "memory:fallback-read", "memory:fallback-read-2"]);
assert.equal(fallbackStore.getCalls, 2, "revalidateMany fallback must read each unique memory once");
assert.equal(fallbackStore.casCalls, 2, "revalidateMany fallback must keep one CAS commit per unique memory");

const affected = runtime.signalSourceChanged("github://acme/repo/commit/main", { scheme: "github.commit", token: "b2" });
assert.deepEqual(affected, ["memory:source", "memory:derived"]);
assert.deepEqual(runtime.check(["memory:source", "memory:derived"]).map((item) => item.status), ["STALE", "STALE"]);
assert.deepEqual(runtime.history().map((item) => item.type), ["MemoryRegistered", "MemoryDerived", "SourceChanged", "MemoryStaled", "MemoryStaled"]);
assert.equal(runtime.eventCount(), runtime.history().length);

const burst = new PremiseRuntime({ tenantId: "tenant:acme", now: () => at });
const burstA = envelope("memory:burst-a", [], "FRESH", "tenant:acme", "github://acme/repo/burst-a");
const burstB = envelope("memory:burst-b", [], "FRESH", "tenant:acme", "github://acme/repo/burst-b");
const burstBoth = {
  ...envelope("memory:burst-both", [], "FRESH", "tenant:acme", "github://acme/repo/burst-a"),
  evidence: [
    { ...burstA.evidence[0], evidenceId: "memory:burst-both:a" },
    { ...burstB.evidence[0], evidenceId: "memory:burst-both:b" }
  ]
};
burst.register({ envelope: burstA, content: {} });
burst.register({ envelope: burstB, content: {} });
burst.register({ envelope: burstBoth, content: {} });
assert.deepEqual(burst.signalSourcesChanged([
  { sourceUri: "github://acme/repo/burst-a", version: { scheme: "github.commit", token: "b2" }, eventId: "source:burst:a", observation: { value: "attested" } },
  { sourceUri: "github://acme/repo/burst-b", version: { scheme: "github.commit", token: "b2" }, eventId: "source:burst:b" }
]), ["memory:burst-a", "memory:burst-b", "memory:burst-both"]);
assert.deepEqual(burst.history().find((item) => item.type === "SourceChanged")?.payload.observation, { value: "attested" });
assert.equal(burst.history("memory:burst-both").filter((item) => item.type === "MemoryStaled").length, 1, "a burst must stale a multi-source memory once");
assert.equal(burst.history("memory:burst-both").find((item) => item.type === "MemoryStaled")?.payload.changes.length, 2);
assert.deepEqual(burst.history("memory:burst-both").find((item) => item.type === "MemoryStaled")?.payload.changes[0].observation, { value: "attested" });
assert.deepEqual(burst.signalSourcesChanged([]), []);
const burstEventsBeforeReplay = burst.history().length;
assert.deepEqual(burst.signalSourcesChanged([
  { sourceUri: "github://acme/repo/burst-a", version: { scheme: "github.commit", token: "b2" }, eventId: "source:burst:a", observation: { value: "attested" } },
  { sourceUri: "github://acme/repo/burst-a", version: { scheme: "github.commit", token: "b2" }, eventId: "source:burst:a", observation: { value: "attested" } }
]), ["memory:burst-a", "memory:burst-both"]);
assert.equal(burst.history().length, burstEventsBeforeReplay, "duplicate source notifications must be idempotent");

const report = await runtime.revalidate("memory:source", async (evidence) => ({ memoryId: "memory:source", evidenceId: evidence.evidenceId, result: "UNCHANGED", status: "FRESH", checkedAt: at, sourceUri: evidence.sourceUri, version: { scheme: "github.commit", token: "b2" } }));
assert.equal(report.status, "FRESH");
assert.equal(runtime.get("memory:source").content.value, "source");
const rejectedCommit = await runtime.revalidateAndAct("memory:source", {
  expectedVersion: "b2",
  commit: () => ({ accepted: false, reason: "VERSION_MISMATCH", observedVersion: "b3" })
});
assert.deepEqual(rejectedCommit, { accepted: false, memoryId: "memory:source", expectedVersion: "b2", reason: "VERSION_MISMATCH", observedVersion: "b3" });
let unsafeApplyCalls = 0;
const casRequired = await runtime.revalidateAndAct("memory:source", {
  expectedVersion: "b2",
  apply: () => { unsafeApplyCalls += 1; return { unsafe: true }; }
});
assert.deepEqual(casRequired, { accepted: false, memoryId: "memory:source", expectedVersion: "b2", reason: "CAS_REQUIRED" });
assert.equal(unsafeApplyCalls, 0, "legacy apply must never produce an effect without atomic commit");

const sharedEvidence = { ...envelope("memory:shared-a").evidence[0], evidenceId: "evidence:shared" };
const sharedA = { ...envelope("memory:shared-a"), evidence: [sharedEvidence] };
const sharedB = { ...envelope("memory:shared-b"), evidence: [sharedEvidence] };
const shared = new PremiseRuntime({ tenantId: "tenant:acme", now: () => at, receiptScope: sharingScope });
shared.register({ envelope: sharedA, content: { value: "a" } });
shared.register({ envelope: sharedB, content: { value: "b" } });
let sharedCalls = 0;
const sharedReports = await shared.revalidateMany(["memory:shared-a", "memory:shared-b"], async (evidence) => {
  sharedCalls += 1;
  return { memoryId: "ignored-by-batch", evidenceId: evidence.evidenceId, result: "UNCHANGED", status: "FRESH", checkedAt: at, sourceUri: evidence.sourceUri };
});
assert.equal(sharedCalls, 1, "revalidateMany must validate an identical evidence key once");
assert.deepEqual(sharedReports.map((item) => [item.memoryId, item.status]), [["memory:shared-a", "FRESH"], ["memory:shared-b", "FRESH"]]);
assert.deepEqual(shared.checkMany(["memory:shared-a", "memory:shared-b"]).map((item) => item.status), ["FRESH", "FRESH"]);

const fallback = new PremiseRuntime({ tenantId: "tenant:acme", now: () => at });
fallback.register({ envelope: { ...envelope("memory:fallback-a"), evidence: [{ ...sharedEvidence, sourceUri: "github://acme/repo/a" }] }, content: {} });
fallback.register({ envelope: { ...envelope("memory:fallback-b"), evidence: [{ ...sharedEvidence, sourceUri: "github://acme/repo/b" }] }, content: {} });
let fallbackCalls = 0;
await fallback.revalidateMany(["memory:fallback-a", "memory:fallback-b"], async (evidence) => {
  fallbackCalls += 1;
  return { memoryId: "ignored-by-batch", result: "UNCHANGED", status: "FRESH", checkedAt: at, sourceUri: evidence.sourceUri };
});
assert.equal(fallbackCalls, 2, "same evidenceId with different payloads must use the conservative fallback");

const concurrent = new PremiseRuntime({ tenantId: "tenant:acme", now: () => at });
concurrent.register({ envelope: envelope("memory:concurrent-a", [], "FRESH", "tenant:acme", "github://acme/repo/concurrent-a"), content: {} });
concurrent.register({ envelope: envelope("memory:concurrent-b", [], "FRESH", "tenant:acme", "github://acme/repo/concurrent-b"), content: {} });
const entered = [];
let release;
let timeout;
const barrier = new Promise((resolve, reject) => {
  release = resolve;
  timeout = setTimeout(() => reject(new Error("revalidateMany did not validate independent groups concurrently")), 250);
});
const concurrentReports = await concurrent.revalidateMany(["memory:concurrent-b", "memory:concurrent-a", "memory:concurrent-b"], async (evidence) => {
  entered.push(evidence.sourceUri);
  if (entered.length === 2) {
    clearTimeout(timeout);
    release();
  }
  await barrier;
  return { memoryId: "ignored-by-batch", result: "UNCHANGED", status: "FRESH", checkedAt: at, sourceUri: evidence.sourceUri };
});
assert.deepEqual(entered, ["github://acme/repo/concurrent-b", "github://acme/repo/concurrent-a"], "independent evidence groups must enter validation together");
assert.deepEqual(concurrentReports.map((item) => item.memoryId), ["memory:concurrent-b", "memory:concurrent-a", "memory:concurrent-b"]);

const dedupStore = new CountingStore();
const dedup = new PremiseRuntime({ store: dedupStore, tenantId: "tenant:acme", now: () => at, receiptScope: sharingScope });
const dedupEvidence = { ...envelope("memory:batch-dedup-a").evidence[0], evidenceId: "evidence:batch-dedup" };
dedup.register({ envelope: { ...envelope("memory:batch-dedup-a"), evidence: [dedupEvidence] }, content: { value: "a" } });
dedup.register({ envelope: { ...envelope("memory:batch-dedup-b"), evidence: [dedupEvidence] }, content: { value: "b" } });
dedup.register({ envelope: envelope("memory:batch-dedup-c"), content: { value: "c" } });
dedupStore.getCalls = 0;
dedupStore.getManyCalls = 0;
dedupStore.putCalls = 0;
let dedupValidatorCalls = 0;
const dedupIds = ["memory:batch-dedup-b", "memory:batch-dedup-a", "memory:batch-dedup-b", "memory:batch-dedup-c", "memory:batch-dedup-a"];
const dedupReports = await dedup.revalidateMany(dedupIds, async (evidence) => {
  dedupValidatorCalls += 1;
  return { memoryId: "ignored-by-batch", evidenceId: evidence.evidenceId, result: "UNCHANGED", status: "FRESH", checkedAt: at, sourceUri: evidence.sourceUri };
});
assert.equal(dedupStore.getManyCalls, 1, "revalidateMany must use one batch read");
assert.equal(dedupStore.getCalls, 0, "revalidateMany must not fall back when getMany is available");
assert.equal(dedupValidatorCalls, 2, "revalidateMany must validate shared evidence once and distinct evidence once");
assert.equal(dedupStore.putCalls, 3, "duplicate memory IDs must not apply validation more than once");
assert.deepEqual(dedupReports.map((item) => item.memoryId), dedupIds, "batch reports must restore the caller's duplicate-ID order");

const cascadeStore = new CountingStore();
const cascade = new PremiseRuntime({ store: cascadeStore, tenantId: "tenant:acme", now: () => at });
const cascadeSourceA = "github://acme/repo/cascade-a";
const cascadeSourceB = "github://acme/repo/cascade-b";
const cascadeSourceC = "github://acme/repo/cascade-unrelated";
cascade.register({ envelope: envelope("memory:cascade-a", [], "FRESH", "tenant:acme", cascadeSourceA), content: { value: "a" } });
cascade.register({ envelope: envelope("memory:cascade-b", [], "FRESH", "tenant:acme", cascadeSourceB), content: { value: "b" } });
cascade.derive({ envelope: envelope("memory:cascade-join", ["memory:cascade-a", "memory:cascade-b"]), content: { value: "join" } });
cascade.derive({ envelope: envelope("memory:cascade-leaf", ["memory:cascade-join"]), content: { value: "leaf" } });
cascade.derive({ envelope: envelope("memory:cascade-branch", ["memory:cascade-a"]), content: { value: "branch" } });
cascade.register({ envelope: envelope("memory:cascade-unrelated", [], "FRESH", "tenant:acme", cascadeSourceC), content: { value: "unrelated" } });
cascadeStore.putCalls = 0;
cascadeStore.eventCalls = 0;
const cascadeA = cascade.signalSourceChanged(cascadeSourceA, { scheme: "github.commit", token: "a2" });
assert.deepEqual(cascadeA, ["memory:cascade-a", "memory:cascade-join", "memory:cascade-branch", "memory:cascade-leaf"]);
assert.equal(new Set(cascadeA).size, cascadeA.length, "a converging cascade must return each affected memory once");
assert.equal(cascadeStore.putCalls, 4, "the first source change must write each affected memory once");
assert.equal(cascadeStore.eventCalls, 5, "the first source change must append one source event and one stale event per memory");
assert.deepEqual(cascade.checkMany(cascadeA).map((item) => item.status), ["STALE", "STALE", "STALE", "STALE"]);

const cascadeB = cascade.signalSourceChanged(cascadeSourceB, { scheme: "github.commit", token: "b2" });
assert.deepEqual(cascadeB, ["memory:cascade-b", "memory:cascade-join", "memory:cascade-leaf"]);
assert.equal(new Set(cascadeB).size, cascadeB.length, "a second source change must not duplicate converged dependents");
assert.equal(cascadeStore.putCalls, 5, "a second source change must only write the newly fresh root");
assert.equal(cascade.history().filter((item) => item.type === "MemoryStaled").length, 5, "already stale cascade nodes must not emit duplicate stale events");
assert.equal(cascade.get("memory:cascade-unrelated").envelope.validity.status, "FRESH", "unrelated source branches must remain fresh");

const cascadePutsAfterTwoChanges = cascadeStore.putCalls;
const cascadeEventsAfterTwoChanges = cascadeStore.eventCalls;
assert.deepEqual(cascade.signalSourceChanged(cascadeSourceA, { scheme: "github.commit", token: "a3" }), cascadeA);
assert.equal(cascadeStore.putCalls, cascadePutsAfterTwoChanges, "a newer change must not rewrite an already stale cascade");
assert.equal(cascadeStore.eventCalls, cascadeEventsAfterTwoChanges + 1, "a newer change must still append its source event");
assert.equal(cascade.history().filter((item) => item.type === "MemoryStaled").length, 5);

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
const restoreBeforeInvalidSnapshot = restored.snapshot();
const invalidRestoreRecord = structuredClone(snapshot.records[0]);
invalidRestoreRecord.envelope.memoryId = "";
assert.throws(
  () => restored.restore({ ...snapshot, records: [...snapshot.records, invalidRestoreRecord] }),
  /Invalid PREMiSE v2 contract/iu
);
assert.deepEqual(restored.snapshot(), restoreBeforeInvalidSnapshot, "an invalid later entry must not partially restore records or events");
const directStore = new InMemoryRuntimeStore();
directStore.restore(snapshot);
const directStoreBeforeInvalidRestore = directStore.snapshot("before-invalid-restore");
assert.throws(
  () => directStore.restore({ ...snapshot, records: [...snapshot.records, invalidRestoreRecord] }),
  /non-empty|Invalid PREMiSE v2 contract/iu
);
const directStoreAfterInvalidRestore = directStore.snapshot("after-invalid-restore");
assert.deepEqual(directStoreAfterInvalidRestore.records, directStoreBeforeInvalidRestore.records, "the store must not partially replace records");
assert.deepEqual(directStoreAfterInvalidRestore.events, directStoreBeforeInvalidRestore.events, "the store must not partially replace events");

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
assert.deepEqual(tenantARuntime.checkMany(["memory:tenant-b-source", "memory:tenant-a-source", "memory:tenant-b-source"]).map((item) => [item.memoryId, item.decision]), [
  ["memory:tenant-b-source", "REJECT"],
  ["memory:tenant-a-source", "REVALIDATE"],
  ["memory:tenant-b-source", "REJECT"]
], "checkMany must preserve order while enforcing tenant isolation");
assert.deepEqual(tenantARuntime.retrieve(["memory:tenant-b-source", "memory:tenant-a-source", "memory:tenant-a-source"]).map((item) => item.envelope.memoryId), ["memory:tenant-a-source"], "retrieve must filter other tenants without changing caller semantics");
await assert.rejects(() => tenantARuntime.revalidateMany(["memory:tenant-b-source"], async () => {
  throw new Error("validator must not see an inaccessible tenant");
}), /not found or inaccessible/);
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

const raceStore = new CountingStore();
const race = new PremiseRuntime({ store: raceStore, tenantId: "tenant:acme", now: () => at });
const raceSourceUri = "github://acme/repo/race";
race.register({ envelope: envelope("memory:race-source", [], "FRESH", "tenant:acme", raceSourceUri), content: { value: "source" } });
race.derive({ envelope: envelope("memory:race-derived", ["memory:race-source"]), content: { value: "derived" } });
race.derive({ envelope: envelope("memory:race-leaf", ["memory:race-derived"]), content: { value: "leaf" } });
let releaseRaceValidation;
let enterRaceValidation;
const raceValidationReleased = new Promise((resolve) => { releaseRaceValidation = resolve; });
const raceValidationEntered = new Promise((resolve) => { enterRaceValidation = resolve; });
const pendingRaceValidation = race.revalidateMany(["memory:race-source"], async (evidence) => {
  enterRaceValidation();
  await raceValidationReleased;
  return { memoryId: "ignored-by-batch", evidenceId: evidence.evidenceId, result: "UNCHANGED", status: "FRESH", checkedAt: at, sourceUri: evidence.sourceUri, version: { scheme: "github.commit", token: "a1" } };
});
await raceValidationEntered;
const raceFirstChange = race.signalSourceChanged(raceSourceUri, { scheme: "github.commit", token: "b2" });
const raceSecondChange = race.signalSourceChanged(raceSourceUri, { scheme: "github.commit", token: "b3" });
assert.deepEqual(raceFirstChange, ["memory:race-source", "memory:race-derived", "memory:race-leaf"]);
assert.deepEqual(raceSecondChange, raceFirstChange);
releaseRaceValidation();
let raceValidationError;
try {
  await pendingRaceValidation;
} catch (error) {
  raceValidationError = error;
}
assert.ok(raceValidationError, "a stale revalidation batch must reject after a concurrent mutation");
assert.match(String(raceValidationError), /conflict|stale|changed|revision|concurrent/i, "a rejected stale batch must identify the concurrent mutation");
assert.deepEqual(
  race.checkMany(["memory:race-source", "memory:race-derived", "memory:race-leaf"]).map((item) => item.status),
  ["STALE", "STALE", "STALE"],
  "a source change during validation must not be overwritten by a stale batch result"
);

class ConditionalRaceStore extends InMemoryRuntimeStore {
  raced = false;

  putAndAppendIfUnchanged(expected, record, event) {
    if (!this.raced) {
      this.raced = true;
      super.put({ ...expected, content: { value: "external-writer" } });
    }
    return super.putAndAppendIfUnchanged(expected, record, event);
  }
}

const conditionalRaceStore = new ConditionalRaceStore();
const conditionalRace = new PremiseRuntime({ store: conditionalRaceStore, tenantId: "tenant:acme", now: () => at });
conditionalRace.register({ envelope: envelope("memory:conditional-race"), content: { value: "original" } });
await assert.rejects(
  conditionalRace.revalidate("memory:conditional-race", async (evidence) => ({
    memoryId: "memory:conditional-race",
    evidenceId: evidence.evidenceId,
    result: "UNCHANGED",
    status: "FRESH",
    checkedAt: at,
    sourceUri: evidence.sourceUri,
    version: { scheme: "github.commit", token: "b2" }
  })),
  /concurrent mutation/i
);
assert.equal(conditionalRace.get("memory:conditional-race").content.value, "external-writer", "conditional persistence must preserve a concurrent writer");

console.log("runtime-core tests passed");
