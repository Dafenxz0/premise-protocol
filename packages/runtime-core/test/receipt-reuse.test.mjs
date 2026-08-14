import assert from "node:assert/strict";
import test from "node:test";
import { PremiseRuntime, RuntimeInstrumentationRecorder, RuntimeReceiptCache } from "../dist/index.js";

const at = "2026-08-13T10:00:00.000Z";

function evidence(id = "shared:evidence", token = "v1") {
  return {
    evidenceId: id,
    sourceUri: "github://example/repo/main",
    observedAt: at,
    version: { scheme: "github.commit", token },
    validator: { id: "github-read", operation: "read" }
  };
}

function envelope(memoryId, item = evidence(), status = "FRESH") {
  return {
    specVersion: "premise/2",
    tenantId: "tenant:test",
    memoryId,
    evidence: [item],
    confidence: { score: null, method: "test", assessedAt: at },
    conflicts: [],
    temporal: { asOf: at },
    validity: { status, checkedAt: at, policy: "VERSIONED" },
    dependsOn: [],
    signatures: []
  };
}

function scopeFactory(authorizationContextDigest = "auth:reader") {
  return (item, record) => ({
    tenantId: record.envelope.tenantId,
    resourceId: item.sourceUri,
    incarnationId: `inc:${item.evidenceId}`,
    versionScheme: item.version.scheme,
    versionToken: `${item.version.scheme}:${item.version.token}`,
    scopes: ["read:/head"],
    queryDigest: "query:headline",
    validatorId: item.validator.id,
    authorizationContextDigest,
    policyDigest: "policy:versioned-read",
    changeSetDigest: null,
    causalFrontier: []
  });
}

function registerPair(runtime, item = evidence()) {
  runtime.register({ envelope: envelope("memory:a", item), content: { value: "a" } });
  runtime.register({ envelope: envelope("memory:b", item), content: { value: "b" } });
}

function unchangedReport(item, checkedAt = at) {
  return {
    memoryId: "validator-owned",
    evidenceId: item.evidenceId,
    result: "UNCHANGED",
    status: "FRESH",
    checkedAt,
    sourceUri: item.sourceUri,
    version: item.version
  };
}

test("completed receipts are reused after the in-flight validation finishes", async () => {
  const recorder = new RuntimeInstrumentationRecorder();
  const cache = new RuntimeReceiptCache({ maxEntries: 8 });
  const runtime = new PremiseRuntime({
    tenantId: "tenant:test",
    now: () => at,
    instrumentation: recorder,
    receiptCache: cache,
    receiptScope: scopeFactory()
  });
  const item = evidence();
  registerPair(runtime, item);
  let validations = 0;
  const validator = async (current) => {
    validations += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return unchangedReport(current);
  };

  const first = await runtime.revalidateMany(["memory:a", "memory:b"], validator);
  assert.equal(validations, 1);
  assert.deepEqual(first.map(({ memoryId }) => memoryId), ["memory:a", "memory:b"]);
  const afterFlight = recorder.snapshot();
  assert.equal(afterFlight.singleFlightLeaders, 1);
  assert.equal(afterFlight.singleFlightJoins, 1);
  assert.equal(afterFlight.receiptMisses, 2);

  const second = await runtime.revalidateMany(["memory:a", "memory:b"], validator);
  assert.equal(validations, 1);
  assert.deepEqual(second.map(({ memoryId }) => memoryId), ["memory:a", "memory:b"]);
  const afterReuse = recorder.snapshot();
  assert.equal(afterReuse.receiptHits, 2);
  assert.equal(afterReuse.singleFlightLeaders, 1);
  assert.equal(afterReuse.singleFlightJoins, 1);
  assert.equal(cache.stats().entries, 1);
});

test("authorization scope differences prevent completed-receipt sharing", async () => {
  const recorder = new RuntimeInstrumentationRecorder();
  const cache = new RuntimeReceiptCache({ maxEntries: 8 });
  const runtime = new PremiseRuntime({
    tenantId: "tenant:test",
    now: () => at,
    instrumentation: recorder,
    receiptCache: cache,
    receiptScope: (item, record) => scopeFactory(record.envelope.memoryId === "memory:a" ? "auth:a" : "auth:b")(item, record)
  });
  registerPair(runtime);
  let validations = 0;
  const reports = await runtime.revalidateMany(["memory:a", "memory:b"], async (item) => {
    validations += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return unchangedReport(item);
  });
  assert.equal(reports.length, 2);
  assert.equal(validations, 2);
  const counters = recorder.snapshot();
  assert.equal(counters.singleFlightLeaders, 2);
  assert.equal(counters.singleFlightJoins, 0);
  assert.equal(cache.stats().entries, 2);
});

test("an incomplete scope disables sharing instead of falling back to a weak key", async () => {
  const recorder = new RuntimeInstrumentationRecorder();
  const runtime = new PremiseRuntime({
    tenantId: "tenant:test",
    now: () => at,
    instrumentation: recorder,
    receiptScope: () => undefined
  });
  registerPair(runtime);
  let validations = 0;
  await runtime.revalidateMany(["memory:a", "memory:b"], async (item) => {
    validations += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return unchangedReport(item);
  });
  const counters = recorder.snapshot();
  assert.equal(validations, 2);
  assert.equal(counters.singleFlightSplits, 2);
  assert.equal(counters.singleFlightJoins, 0);
});

test("the default runtime isolates record-local validators without a scope factory", async () => {
  const recorder = new RuntimeInstrumentationRecorder();
  const runtime = new PremiseRuntime({ tenantId: "tenant:test", now: () => at, instrumentation: recorder });
  registerPair(runtime);
  let validations = 0;
  await runtime.revalidateMany(["memory:a", "memory:b"], async (item) => {
    validations += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return unchangedReport(item);
  });
  assert.equal(validations, 2);
  assert.equal(recorder.snapshot().singleFlightJoins, 0);
  assert.equal(recorder.snapshot().singleFlightSplits, 2);
});

test("a malformed scope object cannot become shareable through string coercion", async () => {
  const recorder = new RuntimeInstrumentationRecorder();
  const runtime = new PremiseRuntime({
    tenantId: "tenant:test",
    now: () => at,
    instrumentation: recorder,
    receiptScope: (item, record) => ({ ...scopeFactory()(item, record), versionToken: undefined })
  });
  registerPair(runtime);
  let validations = 0;
  await runtime.revalidateMany(["memory:a", "memory:b"], async (item) => {
    validations += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return unchangedReport(item);
  });
  assert.equal(validations, 2);
  assert.equal(recorder.snapshot().singleFlightJoins, 0);
  assert.equal(recorder.snapshot().singleFlightSplits, 2);
});

test("a completed receipt cannot cross tenants even when the cache object is shared", async () => {
  const cache = new RuntimeReceiptCache({ maxEntries: 8 });
  const first = new PremiseRuntime({ tenantId: "tenant:a", now: () => at, receiptCache: cache, receiptScope: scopeFactory() });
  const second = new PremiseRuntime({ tenantId: "tenant:b", now: () => at, receiptCache: cache, receiptScope: scopeFactory() });
  first.register({ envelope: { ...envelope("memory:a", evidence(), "FRESH"), tenantId: "tenant:a" }, content: { value: "a" } });
  second.register({ envelope: { ...envelope("memory:b", evidence(), "FRESH"), tenantId: "tenant:b" }, content: { value: "b" } });
  let validations = 0;
  const validator = async (item) => {
    validations += 1;
    return unchangedReport(item);
  };
  await first.revalidate("memory:a", validator, "tenant:a:first");
  await second.revalidate("memory:b", validator, "tenant:b:first");
  assert.equal(validations, 2);
  assert.equal(cache.stats().entries, 2);
});

test("expired completed receipts are rejected and source changes invalidate them", async () => {
  let now = at;
  const recorder = new RuntimeInstrumentationRecorder();
  const cache = new RuntimeReceiptCache({ maxEntries: 8 });
  const runtime = new PremiseRuntime({
    tenantId: "tenant:test",
    now: () => now,
    instrumentation: recorder,
    receiptCache: cache,
    receiptTtlMs: 10,
    receiptScope: scopeFactory()
  });
  registerPair(runtime);
  let validations = 0;
  const validator = async (item) => {
    validations += 1;
    return unchangedReport(item, now);
  };
  await runtime.revalidate("memory:a", validator);
  now = "2026-08-13T10:00:00.011Z";
  await runtime.revalidate("memory:a", validator);
  assert.equal(validations, 2);
  assert.equal(recorder.snapshot().staleReceiptRejections, 1);

  now = "2026-08-13T10:00:01.000Z";
  await runtime.revalidate("memory:b", validator);
  const beforeSignal = validations;
  runtime.signalSourceChanged("github://example/repo/main", { scheme: "github.commit", token: "v2" });
  await runtime.revalidate("memory:b", validator);
  assert.equal(validations, beforeSignal + 1);
  assert.ok(recorder.snapshot().receiptMisses >= 1);
});

test("receipt cache requires an explicit complete scope factory", () => {
  assert.throws(() => new PremiseRuntime({ receiptCache: new RuntimeReceiptCache() }), /receiptScope factory/u);
});

test("a changed version cannot be cached under the old evidence scope", async () => {
  const cache = new RuntimeReceiptCache({ maxEntries: 8 });
  const runtime = new PremiseRuntime({
    tenantId: "tenant:test",
    now: () => at,
    receiptCache: cache,
    receiptScope: scopeFactory()
  });
  registerPair(runtime);
  let validations = 0;
  const validator = async (item) => {
    validations += 1;
    return { ...unchangedReport(item), version: { scheme: "github.commit", token: "v2" } };
  };
  await runtime.revalidate("memory:a", validator, "version-advance:a");
  assert.equal(cache.stats().entries, 0);
  await runtime.revalidate("memory:a", validator, "version-advance:b");
  assert.equal(validations, 2);
  assert.equal(cache.stats().entries, 1);
});

test("non-fresh, future-dated and externally-staled observations cannot reuse a receipt", async () => {
  const cache = new RuntimeReceiptCache({ maxEntries: 8 });
  const runtime = new PremiseRuntime({ tenantId: "tenant:test", now: () => at, receiptCache: cache, receiptScope: scopeFactory() });
  registerPair(runtime);
  let validations = 0;
  await runtime.revalidate("memory:a", async (item) => {
    validations += 1;
    return { ...unchangedReport(item), status: "UNKNOWN", checkedAt: "2026-08-13T11:00:00.000Z", version: undefined };
  }, "invalid-receipt:first");
  assert.equal(cache.stats().entries, 0);
  const current = runtime.get("memory:a");
  runtime.store.put({ ...current, envelope: { ...current.envelope, validity: { ...current.envelope.validity, status: "STALE" } } });
  await runtime.revalidate("memory:a", async (item) => {
    validations += 1;
    return unchangedReport(item);
  }, "invalid-receipt:second");
  assert.equal(validations, 2);
  assert.equal(cache.stats().entries, 1);
});
