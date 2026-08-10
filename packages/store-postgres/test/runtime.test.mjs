import assert from "node:assert/strict";
import { PostgresRuntimeStore } from "../dist/index.js";

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
    if (statement.startsWith("SELECT envelope_json::text AS envelope_json, content_json::text AS content_json FROM \"premise_v2_records\" WHERE")) {
      const row = this.records.get(values.at(-1));
      return { rows: row === undefined ? [] : [row] };
    }
    if (statement.startsWith("SELECT envelope_json::text AS envelope_json, content_json::text AS content_json FROM \"premise_v2_records\" ORDER")) {
      return { rows: [...this.records.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row) };
    }
    if (statement.startsWith("INSERT INTO \"premise_v2_events\"")) {
      if (this.events.has(values[1])) return { rows: [] };
      const row = { event_id: values[2], event_json: values[3] };
      this.events.set(values[1], row);
      return statement.includes("RETURNING") ? { rows: [row] } : { rows: [] };
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

const request = { tenantId: "tenant:acme", operation: "register", key: "http:1", requestHash: "sha256:http-v1:one" };
const claim = await store.claimHttpIdempotency(request);
assert.equal(claim.kind, "new");
assert.equal((await store.claimHttpIdempotency(request)).kind, "in-progress");
await store.completeHttpIdempotency({ ...request, token: claim.token, response: { status: 201, body: { memoryId: "memory:postgres-runtime", status: "stored" }, headers: { "content-type": "application/json" } } });
assert.deepEqual(await store.claimHttpIdempotency(request), { kind: "replay", response: { status: 201, body: { memoryId: "memory:postgres-runtime", status: "stored" }, headers: { "content-type": "application/json" } } });
assert.equal((await store.claimHttpIdempotency({ ...request, requestHash: "sha256:http-v1:two" })).kind, "conflict");

const snapshot = await store.snapshot(at);
const snapshotInsert = client.queries.find(({ statement }) => statement.startsWith('INSERT INTO "premise_v2_snapshots"'));
assert.ok(snapshotInsert);
assert.match(snapshotInsert.statement, /VALUES \(\$1, \$2, \$3, \$4::jsonb\)/);
assert.equal(snapshotInsert.values[1], at);
assert.equal(snapshotInsert.values[2], at);
await store.restore(snapshot);
assert.deepEqual(await store.get(envelope.memoryId), { envelope, content: { answer: 42 } });
assert.equal((await store.listEvents()).length, 1);
console.log("store-postgres runtime tests passed");
