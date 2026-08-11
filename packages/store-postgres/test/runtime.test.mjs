import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { POSTGRES_RUNTIME_MIGRATIONS, POSTGRES_RUNTIME_SCHEMA_VERSION, PostgresLexicalIndex, PostgresRuntimeStore } from "../dist/index.js";

assert.ok(POSTGRES_RUNTIME_SCHEMA_VERSION >= 5);
const permissiveRepair = POSTGRES_RUNTIME_MIGRATIONS.find(({ version }) => version === 5)?.sql;
assert.ok(permissiveRepair);
for (const table of ["records", "events", "snapshots", "replay_checkpoints", "http_idempotency"]) {
  assert.match(permissiveRepair, new RegExp(`CREATE POLICY [^\\n]*${table}_tenant_policy[\\s\\S]*AS PERMISSIVE[\\s\\S]*current_setting\\('premise\\.tenant_id', true\\)`, "u"));
}
const staticCoreRls = await readFile(new URL("../migrations/002-tenant-rls.sql", import.meta.url), "utf8");
assert.match(staticCoreRls, /CREATE POLICY premise_v2_records_tenant_policy[\s\S]*AS PERMISSIVE/u);

const at = "2026-08-10T10:00:00Z";
const envelope = {
  specVersion: "premise/2",
  tenantId: "tenant:acme",
  memoryId: "memory:postgres-runtime",
  evidence: [{ evidenceId: "evidence:1", sourceUri: "memory://postgres-runtime", observedAt: at, version: { scheme: "test", token: "v1" }, validator: { id: "test", operation: "read" } }],
  confidence: { score: null, method: "test", assessedAt: at },
  conflicts: [],
  temporal: { asOf: at },
  validity: { status: "FRESH", checkedAt: at, policy: "MANUAL" },
  dependsOn: [],
  signatures: []
};
const secondEnvelope = { ...envelope, memoryId: "memory:postgres-runtime-2", evidence: [{ ...envelope.evidence[0], evidenceId: "evidence:2", sourceUri: "memory://postgres-runtime-2" }] };
const event = {
  specVersion: "premise/2",
  tenantId: "tenant:acme",
  eventId: "event:postgres-runtime:1",
  operationId: "operation:1",
  idempotencyKey: "request:postgres-runtime:1",
  requestDigest: "sha256:request-1",
  type: "MemoryRegistered",
  occurredAt: at,
  memoryId: envelope.memoryId,
  payload: { envelope }
};

class InMemoryPostgresClient {
  records = new Map();
  events = new Map();
  snapshots = new Map();
  httpIdempotency = new Map();
  migrations = new Set();
  queries = [];

  async query(sql, values = []) {
    const statement = sql.replace(/\s+/g, " ").trim();
    this.queries.push({ statement, values: [...values] });
    if (statement.startsWith("CREATE TABLE") || statement.startsWith("CREATE INDEX") || statement.startsWith("ALTER TABLE") || statement.startsWith("DROP POLICY") || statement.startsWith("CREATE POLICY")) return { rows: [] };
    if (statement.startsWith("SELECT pg_advisory_xact_lock") || statement.startsWith("SELECT set_config") || statement.startsWith("SET TRANSACTION")) return { rows: [] };
    if (statement.startsWith('SELECT version FROM "premise_v2_schema_migrations"')) return { rows: [...this.migrations].sort((a, b) => a - b).map((version) => ({ version })) };
    if (statement.startsWith('INSERT INTO "premise_v2_schema_migrations"')) { this.migrations.add(values[0]); return { rows: [], rowCount: 1 }; }
    if (statement.startsWith("INSERT INTO \"premise_v2_records\"")) {
      const key = values.length >= 4 ? values[1] : values[0];
      if (statement.includes("ON CONFLICT (tenant_id, memory_id) DO NOTHING") && this.records.has(key)) return { rows: [], rowCount: 0 };
      this.records.set(key, { envelope_json: values.length >= 4 ? values[2] : values[1], content_json: values.length >= 4 ? values[3] : values[2] });
      return statement.includes("RETURNING memory_id") ? { rows: [{ memory_id: key }], rowCount: 1 } : { rows: [] };
    }
    if (statement.startsWith('SELECT (SELECT COUNT(*) FROM "premise_v2_records"')) {
      const tenant = values[0];
      const records = [...this.records.values()].filter((row) => tenant === undefined || JSON.parse(row.envelope_json).tenantId === tenant);
      const events = [...this.events.values()].filter((row) => tenant === undefined || row.tenant_id === tenant);
      return { rows: [{ memories: records.length, events: events.length }] };
    }
    if (statement.startsWith("WITH candidates AS MATERIALIZED")) {
      const query = String(values[0]).toLowerCase();
      const tenant = values.length === 4 ? values[1] : undefined;
      const candidateLimit = Number(values.at(-2));
      const limit = Number(values.at(-1));
      const rows = [...this.records.entries()]
        .map(([memoryId, row]) => ({ ...row, memory_id: memoryId, tenant_id: JSON.parse(row.envelope_json).tenantId }))
        .filter((row) => (tenant === undefined || row.tenant_id === tenant) && row.content_json.toLowerCase().includes(query))
        .sort((left, right) => left.memory_id.localeCompare(right.memory_id))
        .slice(0, candidateLimit)
        .map((row) => ({ ...row, rank: 1 }));
      return { rows: rows.slice(0, limit) };
    }
    if (statement.startsWith('SELECT tenant_id, envelope_json::text AS envelope_json, content_json::text AS content_json FROM "premise_v2_records"')) {
      const limit = Number(values.at(-1));
      const afterTenant = values.length === 3 ? String(values[0]) : "";
      const afterMemory = values.length === 3 ? String(values[1]) : "";
      const rows = [...this.records.values()]
        .map((row) => ({ ...row, tenant_id: JSON.parse(row.envelope_json).tenantId }))
        .sort((left, right) => left.tenant_id.localeCompare(right.tenant_id) || JSON.parse(left.envelope_json).memoryId.localeCompare(JSON.parse(right.envelope_json).memoryId))
        .filter((row) => row.tenant_id > afterTenant || (row.tenant_id === afterTenant && JSON.parse(row.envelope_json).memoryId > afterMemory));
      return { rows: rows.slice(0, limit) };
    }
    if (statement.includes("memory_id = ANY")) {
      const tenant = values.length === 2 ? String(values[0]) : undefined;
      const requested = new Set(Array.isArray(values.at(-1)) ? values.at(-1) : []);
      const rows = [...this.records.entries()]
        .filter(([memoryId, row]) => requested.has(memoryId) && (tenant === undefined || JSON.parse(row.envelope_json).tenantId === tenant))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, row]) => row);
      return { rows };
    }
    if (statement.startsWith("SELECT envelope_json::text AS envelope_json, content_json::text AS content_json FROM \"premise_v2_records\" WHERE")) {
      const row = this.records.get(values.at(-1));
      return { rows: row === undefined ? [] : [row] };
    }
    if (statement.startsWith("SELECT envelope_json::text AS envelope_json, content_json::text AS content_json FROM \"premise_v2_records\" ORDER")) {
      return { rows: [...this.records.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row) };
    }
    if (statement.startsWith("INSERT INTO \"premise_v2_events\"")) {
      if (this.events.has(values[1])) return { rows: [] };
      const row = { sequence: this.events.size + 1, tenant_id: values[0], event_id: values[2], event_json: values[3] };
      this.events.set(values[1], row);
      return statement.includes("RETURNING") ? { rows: [row] } : { rows: [] };
    }
    if (statement.startsWith('SELECT sequence, tenant_id, event_json::text AS event_json FROM "premise_v2_events"')) {
      const cursor = Number(values.at(-2));
      const tenant = values.length === 3 ? values[0] : undefined;
      const limit = Number(values.at(-1));
      const rows = [...this.events.values()]
        .filter((row) => row.sequence > cursor && (tenant === undefined || row.tenant_id === tenant))
        .sort((left, right) => left.sequence - right.sequence);
      return { rows: rows.slice(0, limit) };
    }
    if (statement.startsWith("SELECT event_id, event_json::text AS event_json FROM \"premise_v2_events\" WHERE")) {
      const row = this.events.get(values.at(-1));
      return { rows: row === undefined ? [] : [row] };
    }
    if (statement.startsWith("SELECT 1 AS present FROM \"premise_v2_events\" WHERE")) {
      return { rows: this.events.has(values.at(-1)) ? [{ present: 1 }] : [] };
    }
    if (statement.startsWith("SELECT event_json::text AS event_json FROM \"premise_v2_events\" ORDER")) {
      return { rows: [...this.events.values()] };
    }
    if (statement.startsWith('INSERT INTO "premise_v2_snapshots"')) {
      this.snapshots.set(values[1], { snapshot_json: values[2] });
      return { rows: [] };
    }
    if (statement.startsWith('SELECT snapshot_json::text AS snapshot_json FROM "premise_v2_snapshots"')) {
      const row = this.snapshots.get(values.at(-1));
      return { rows: row === undefined ? [] : [row] };
    }
    if (statement.startsWith('INSERT INTO "premise_v2_http_idempotency"')) {
      const key = `${values[0]}\u0000${values[1]}\u0000${values[2]}`;
      if (this.httpIdempotency.has(key)) return { rows: [], rowCount: 0 };
      const row = { request_hash: values[3], state: "IN_PROGRESS", lease_token: values[4], status_code: null, response_json: null, response_headers: "{}", updated_at: new Date().toISOString() };
      this.httpIdempotency.set(key, row);
      return { rows: [{ lease_token: values[4] }], rowCount: 1 };
    }
    if (statement.startsWith('SELECT request_hash, state, lease_token')) {
      const key = `${values[0]}\u0000${values[1]}\u0000${values[2]}`;
      const row = this.httpIdempotency.get(key);
      return { rows: row === undefined ? [] : [row] };
    }
    if (statement.startsWith('UPDATE "premise_v2_http_idempotency" SET lease_token')) {
      const key = `${values[0]}\u0000${values[1]}\u0000${values[2]}`;
      const row = this.httpIdempotency.get(key);
      if (row !== undefined) row.lease_token = values[3];
      return { rows: [], rowCount: row === undefined ? 0 : 1 };
    }
    if (statement.startsWith('UPDATE "premise_v2_http_idempotency" SET state')) {
      const key = `${values[0]}\u0000${values[1]}\u0000${values[2]}`;
      const row = this.httpIdempotency.get(key);
      if (row === undefined || row.state !== "IN_PROGRESS" || row.request_hash !== values[3] || row.lease_token !== values[7]) return { rows: [], rowCount: 0 };
      Object.assign(row, { state: "COMPLETED", status_code: values[4], response_json: values[5], response_headers: values[6] });
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith('SELECT state, request_hash, lease_token')) {
      const key = `${values[0]}\u0000${values[1]}\u0000${values[2]}`;
      const row = this.httpIdempotency.get(key);
      return { rows: row === undefined ? [] : [row] };
    }
    if (statement.startsWith('DELETE FROM "premise_v2_http_idempotency"')) {
      const key = `${values[0]}\u0000${values[1]}\u0000${values[2]}`;
      this.httpIdempotency.delete(key);
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith('DELETE FROM "premise_v2_events"')) { this.events.clear(); return { rows: [] }; }
    if (statement.startsWith('DELETE FROM "premise_v2_snapshots"')) { this.snapshots.clear(); return { rows: [] }; }
    if (statement.startsWith('DELETE FROM "premise_v2_replay_checkpoints"')) return { rows: [] };
    if (statement.startsWith("DELETE FROM \"premise_v2_records\"")) {
      this.records.clear();
      this.events.clear();
      this.snapshots.clear();
      return { rows: [] };
    }
    throw new Error(`Unhandled SQL in runtime test double: ${statement}`);
  }

  async transaction(action) {
    return action(this);
  }
}

const client = new InMemoryPostgresClient();
const store = new PostgresRuntimeStore(client);
await store.migrate();
await store.put({ envelope, content: { answer: 42 } });
assert.deepEqual(await store.get(envelope.memoryId), { envelope, content: { answer: 42 } });
await store.appendEvent(event);
await store.appendEvent(event);
await assert.rejects(() => store.appendEvent({ ...event, eventId: "event:postgres-runtime:conflict", requestDigest: "sha256:other" }), /Conflicting idempotency key/);
assert.equal((await store.listEvents()).length, 1);

await store.put({ envelope: secondEnvelope, content: { answer: 43 } });
const batchQueryStart = client.queries.length;
assert.deepEqual((await store.getMany([secondEnvelope.memoryId, envelope.memoryId, secondEnvelope.memoryId])).map(({ envelope: loadedEnvelope }) => loadedEnvelope.memoryId), [envelope.memoryId, secondEnvelope.memoryId]);
const batchQueries = client.queries.slice(batchQueryStart).filter(({ statement }) => statement.includes("memory_id = ANY"));
assert.equal(batchQueries.length, 1, "PostgreSQL getMany must use one SQL query");
assert.deepEqual(batchQueries[0].values, [[secondEnvelope.memoryId, envelope.memoryId]]);
const loadedRecords = [];
const loadedEvents = [];
const queryStart = client.queries.length;
assert.deepEqual(await store.loadIncrementally({
  batchSize: 1,
  onRecord: (record) => loadedRecords.push(record),
  onEvent: (loadedEvent, sequence) => loadedEvents.push({ event: loadedEvent, sequence })
}), { records: 2, events: 1 });
assert.deepEqual(loadedRecords.map(({ envelope: loadedEnvelope }) => loadedEnvelope.memoryId), [envelope.memoryId, secondEnvelope.memoryId]);
assert.equal(loadedEvents[0].sequence, 1);
assert.deepEqual(await store.counts(), { memories: 2, events: 1 });
const lexicalHits = await store.search("answer", { limit: 1, candidateLimit: 2, filter: { tenantId: "tenant:acme" } });
assert.equal(lexicalHits.length, 1);
assert.equal(lexicalHits[0].record.envelope.tenantId, "tenant:acme");
assert.equal(lexicalHits[0].vectorScore, 0);
const searchQuery = client.queries.find(({ statement }) => statement.startsWith("WITH candidates AS MATERIALIZED"));
assert.ok(searchQuery);
assert.match(searchQuery.statement, /LIMIT \$3 \) SELECT tenant_id, memory_id[\s\S]*ts_rank_cd/u);
assert.ok(searchQuery.statement.indexOf("LIMIT $3") < searchQuery.statement.indexOf("ts_rank_cd"));
assert.deepEqual(searchQuery.values, ["answer", "tenant:acme", 2, 1]);
let durabilityWaits = 0;
const lexicalIndex = new PostgresLexicalIndex(store, { awaitDurability: () => { durabilityWaits += 1; } });
await lexicalIndex.upsert({ id: envelope.memoryId, text: "answer", content: { answer: 42 }, metadata: { tenantId: "tenant:acme" } });
assert.equal(durabilityWaits, 1);
await assert.rejects(() => store.search("answer", { vectorWeight: 1 }), /vectorWeight/);
await assert.rejects(() => store.search("answer", { candidateLimit: 0 }), /candidateLimit/);
await assert.rejects(() => store.search("answer", { limit: 2, candidateLimit: 1 }), /candidateLimit/);
await assert.rejects(() => store.search("answer", { candidateLimit: 10_001 }), /candidateLimit/);
const loadQueries = client.queries.slice(queryStart).map(({ statement }) => statement);
assert.ok(loadQueries.filter((statement) => statement.startsWith('SELECT tenant_id, envelope_json')).length >= 2);
assert.ok(loadQueries.filter((statement) => statement.startsWith('SELECT sequence, tenant_id, event_json')).length >= 2);
assert.equal(loadQueries.some((statement) => statement.includes("snapshot_json")), false);
assert.ok(client.queries.some(({ statement }) => statement.includes("to_tsvector('simple', content_json::text)")));
await assert.rejects(() => store.loadIncrementally({ batchSize: 10_001, onRecord: () => undefined, onEvent: () => undefined }), /batchSize/);
await assert.rejects(() => store.loadIncrementally({ batchSize: 1, onRecord: () => { throw new Error("startup hydration failed"); }, onEvent: () => undefined }), /startup hydration failed/);
const scopedStore = new PostgresRuntimeStore(client, { tenantId: "tenant:acme" });
assert.deepEqual(await scopedStore.loadIncrementally({ batchSize: 1, onRecord: () => undefined, onEvent: () => undefined }), { records: 2, events: 1 });

const request = { tenantId: "tenant:acme", operation: "register", key: "http:1", requestHash: "sha256:http-v1:one" };
const claim = await store.claimHttpIdempotency(request);
assert.equal(claim.kind, "new");
assert.equal((await store.claimHttpIdempotency(request)).kind, "in-progress");
await store.completeHttpIdempotency({ ...request, token: claim.token, response: { status: 201, body: { memoryId: "memory:postgres-runtime", status: "stored" }, headers: { "content-type": "application/json" } } });
assert.deepEqual(await store.claimHttpIdempotency(request), { kind: "replay", response: { status: 201, body: { memoryId: "memory:postgres-runtime", status: "stored" }, headers: { "content-type": "application/json" } } });
assert.equal((await store.claimHttpIdempotency({ ...request, requestHash: "sha256:http-v1:two" })).kind, "conflict");

const streamedRestore = await store.restoreIncrementally({
  source: async (sink) => {
    await sink.onRecord({ envelope, content: { answer: 42 } });
    await sink.onEvent(event);
    return { capturedAt: at, records: 1, events: 1 };
  }
});
assert.deepEqual(streamedRestore, { capturedAt: at, records: 1, events: 1 });
assert.deepEqual(await store.get(envelope.memoryId), { envelope, content: { answer: 42 } });
assert.equal((await store.listEvents()).length, 1);

const snapshot = await store.snapshot(at);
const snapshotInsert = client.queries.find(({ statement }) => statement.startsWith('INSERT INTO "premise_v2_snapshots"'));
assert.ok(snapshotInsert);
assert.match(snapshotInsert.statement, /VALUES \(\$1, \$2, \$3, \$4::jsonb\)/);
assert.equal(snapshotInsert.values[1], at);
assert.equal(snapshotInsert.values[2], at);
await store.restore(snapshot);
assert.deepEqual(await store.get(envelope.memoryId), { envelope, content: { answer: 42 } });
assert.equal((await store.listEvents()).length, 1);
const otherTenantEnvelope = { ...envelope, tenantId: "tenant:other", memoryId: "memory:postgres-other" };
await store.put({ envelope: otherTenantEnvelope, content: { answer: "other" } });
const isolationQueryStart = client.queries.length;
assert.deepEqual(await scopedStore.getMany([envelope.memoryId, otherTenantEnvelope.memoryId, envelope.memoryId]), [{ envelope, content: { answer: 42 } }]);
const isolationQueries = client.queries.slice(isolationQueryStart).filter(({ statement }) => statement.includes("memory_id = ANY"));
assert.equal(isolationQueries.length, 1, "tenant-scoped PostgreSQL getMany must use one SQL query");
assert.deepEqual(isolationQueries[0].values, ["tenant:acme", [envelope.memoryId, otherTenantEnvelope.memoryId]]);
console.log("store-postgres runtime tests passed");
