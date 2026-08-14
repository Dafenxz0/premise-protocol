import assert from "node:assert/strict";

const url = process.env.POSTGRES_URL;
if (!url) {
  console.log("store-postgres PostgreSQL integration skipped: POSTGRES_URL is not configured");
  process.exit(0);
}

let pg;
try {
  pg = await import("pg");
} catch {
  console.log("store-postgres PostgreSQL integration skipped: optional pg package is not installed");
  process.exit(0);
}

const { Pool } = pg;
const { PostgresRuntimeStore, PostgresSignatureReplayStore, PostgresValidationLeaseStore } = await import("../dist/index.js");
const pool = new Pool({ connectionString: url });
const prefix = `premise_v2_ci_${process.pid}`;
const at = new Date().toISOString();
const envelope = {
  specVersion: "premise/2",
  tenantId: "tenant:ci",
  memoryId: "memory:ci",
  evidence: [{ evidenceId: "e:ci", sourceUri: "memory://ci", observedAt: at }],
  confidence: { score: null, method: "integration", assessedAt: at },
  conflicts: [],
  temporal: { asOf: at },
  validity: { status: "FRESH", checkedAt: at, policy: "MANUAL" },
  dependsOn: [],
  signatures: []
};
const event = {
  specVersion: "premise/2",
  tenantId: "tenant:ci",
  eventId: "event:ci",
  operationId: "operation:ci",
  idempotencyKey: "request:ci",
  requestDigest: "sha256:ci",
  type: "MemoryRegistered",
  occurredAt: at,
  memoryId: envelope.memoryId,
  payload: { envelope }
};

const adapter = {
  query: (sql, values) => pool.query(sql, values ? [...values] : []),
  transaction: async (action) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action({ query: (sql, values) => client.query(sql, values ? [...values] : []) });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the original error */ }
      throw error;
    } finally {
      client.release();
    }
  },
  close: () => pool.end()
};

const store = new PostgresRuntimeStore(adapter, { tablePrefix: prefix, tenantId: "tenant:ci" });
try {
  await store.migrate();
  const leaseStore = new PostgresValidationLeaseStore(adapter, { tableName: `${prefix}_validation_leases` });
  await leaseStore.initialize();
  const leaseScope = { tenantId: "tenant:ci", resourceId: "resource:integration" };
  const leaseRequest = { ...leaseScope, owner: "agent:one", leaseId: "lease:one", expiresAt: 2_000 };
  const leaseContender = { ...leaseScope, owner: "agent:two", leaseId: "lease:two", expiresAt: 2_000 };
  const [leaseFirst, leaseSecond] = await Promise.all([
    leaseStore.acquire(leaseRequest, 1_000),
    leaseStore.acquire(leaseContender, 1_000)
  ]);
  assert.deepEqual([leaseFirst.kind, leaseSecond.kind].sort(), ["ACQUIRED", "HELD"]);
  const acquiredLease = leaseFirst.kind === "ACQUIRED" ? leaseFirst.lease : leaseSecond.lease;
  assert.equal((await leaseStore.validate({ ...leaseScope, owner: acquiredLease.owner, leaseId: acquiredLease.leaseId, fencingToken: acquiredLease.fencingToken }, 1_000)).kind, "VALID");
  assert.equal((await leaseStore.release({ ...leaseScope, owner: acquiredLease.owner, leaseId: acquiredLease.leaseId, fencingToken: acquiredLease.fencingToken }, 1_100)).kind, "RELEASED");
  const replacement = await leaseStore.acquire(leaseContender, 1_101);
  assert.equal(replacement.kind, "ACQUIRED");
  assert.equal(replacement.lease.fencingToken > acquiredLease.fencingToken, true);
  const otherTenant = await leaseStore.acquire({ ...leaseContender, tenantId: "tenant:other" }, 1_000);
  assert.equal(otherTenant.kind, "ACQUIRED");
  const signatureReplay = new PostgresSignatureReplayStore(adapter, { tablePrefix: prefix, tenantId: "tenant:ci" });
  await signatureReplay.initialize();
  const signatureClaim = { key: "signature:integration", tenantId: "tenant:ci", signatureId: "sig:integration", keyId: "key:integration", signedAt: at, acceptedAt: at, expiresAt: new Date(Date.parse(at) + 60_000).toISOString() };
  const concurrentClaims = await Promise.all([signatureReplay.claim(signatureClaim), signatureReplay.claim(signatureClaim)]);
  assert.deepEqual(concurrentClaims.sort(), [false, true], "PostgreSQL replay claims must be atomic");
  assert.equal(await new PostgresSignatureReplayStore(adapter, { tablePrefix: prefix, tenantId: "tenant:ci" }).claim(signatureClaim), false, "replay state must survive a new store instance");
  const secondSignatureClaim = { ...signatureClaim, key: "signature:integration:second", signatureId: "sig:integration:second" };
  assert.equal(await signatureReplay.claimMany([signatureClaim, secondSignatureClaim]), false, "multi-signature replay claims must roll back atomically");
  assert.equal(await signatureReplay.claim(secondSignatureClaim), true, "a failed multi-claim must not partially consume later signatures");
  const otherTenantReplay = new PostgresSignatureReplayStore(adapter, { tablePrefix: prefix, tenantId: "tenant:other" });
  await otherTenantReplay.initialize();
  assert.equal(await otherTenantReplay.claim({ ...signatureClaim, tenantId: "tenant:other" }), true, "replay state must be tenant-scoped");
  await store.putAndAppend({ envelope, content: { answer: 42 } }, event);
  await store.appendEvent(event);
  assert.deepEqual((await store.get(envelope.memoryId)).content, { answer: 42 });
  const snapshot = await store.snapshot(at);
  assert.equal(snapshot.events.length, 1);
  const streamedRestore = await store.restoreIncrementally({
    source: async (sink) => {
      await sink.onRecord({ envelope, content: { answer: 42 } });
      await sink.onEvent(event);
      return { capturedAt: at, records: 1, events: 1 };
    }
  });
  assert.deepEqual(streamedRestore, { capturedAt: at, records: 1, events: 1 });
  let replayed = 0;
  assert.equal(await store.replay(() => { replayed += 1; }, { consumerId: "ci" }), 1);
  assert.equal(await store.replay(() => { replayed += 1; }, { consumerId: "ci" }), 0);
  assert.equal(replayed, 1);
  const request = { tenantId: "tenant:ci", operation: "register", key: "http:ci", requestHash: "sha256:http-v1:ci" };
  const claim = await store.claimHttpIdempotency(request);
  assert.equal(claim.kind, "new");
  assert.equal((await store.claimHttpIdempotency(request)).kind, "in-progress");
  await store.completeHttpIdempotency({ ...request, token: claim.token, response: { status: 201, body: { accepted: true }, headers: { "content-type": "application/json" } } });
  assert.deepEqual(await store.claimHttpIdempotency(request), { kind: "replay", response: { status: 201, body: { accepted: true }, headers: { "content-type": "application/json" } } });
  assert.equal((await store.claimHttpIdempotency({ ...request, requestHash: "sha256:http-v1:other" })).kind, "conflict");
} finally {
  const client = await pool.connect();
  try {
  await client.query(`DROP TABLE IF EXISTS "${prefix}_validation_leases", "${prefix}_signature_replays", "${prefix}_http_idempotency", "${prefix}_replay_checkpoints", "${prefix}_snapshots", "${prefix}_events", "${prefix}_records", "${prefix}_schema_migrations"`);
  } finally {
    client.release();
  }
  await store.close();
}

console.log("store-postgres PostgreSQL integration passed");
