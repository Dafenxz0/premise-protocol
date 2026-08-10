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
const { PostgresRuntimeStore } = await import("../dist/index.js");
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
  await store.putAndAppend({ envelope, content: { answer: 42 } }, event);
  await store.appendEvent(event);
  assert.deepEqual((await store.get(envelope.memoryId)).content, { answer: 42 });
  const snapshot = await store.snapshot(at);
  assert.equal(snapshot.events.length, 1);
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
    await client.query(`DROP TABLE IF EXISTS "${prefix}_http_idempotency", "${prefix}_replay_checkpoints", "${prefix}_snapshots", "${prefix}_events", "${prefix}_records", "${prefix}_schema_migrations"`);
  } finally {
    client.release();
  }
  await store.close();
}

console.log("store-postgres PostgreSQL integration passed");
