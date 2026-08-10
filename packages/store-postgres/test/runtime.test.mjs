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

  async query(sql, values = []) {
    const statement = sql.replace(/\s+/g, " ").trim();
    if (statement.startsWith("CREATE TABLE") || statement.startsWith("CREATE INDEX")) return { rows: [] };
    if (statement.startsWith("INSERT INTO \"premise_v2_records\"")) {
      this.records.set(values[0], { envelope_json: values[2], content_json: values[3] });
      return { rows: [] };
    }
    if (statement.startsWith("SELECT envelope_json, content_json FROM \"premise_v2_records\" WHERE")) {
      const row = this.records.get(values[0]);
      return { rows: row === undefined ? [] : [row] };
    }
    if (statement.startsWith("SELECT envelope_json, content_json FROM \"premise_v2_records\" ORDER")) {
      return { rows: [...this.records.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row) };
    }
    if (statement.startsWith("INSERT INTO \"premise_v2_events\"")) {
      if (this.events.has(values[0])) return { rows: [] };
      const row = { event_id: values[1], event_json: values[3] };
      this.events.set(values[0], row);
      return statement.includes("RETURNING") ? { rows: [row] } : { rows: [] };
    }
    if (statement.startsWith("SELECT event_id, event_json FROM \"premise_v2_events\" WHERE")) {
      const row = this.events.get(values[0]);
      return { rows: row === undefined ? [] : [row] };
    }
    if (statement.startsWith("SELECT 1 AS present FROM \"premise_v2_events\" WHERE")) {
      return { rows: this.events.has(values[0]) ? [{ present: 1 }] : [] };
    }
    if (statement.startsWith("SELECT event_json FROM \"premise_v2_events\" ORDER")) {
      return { rows: [...this.events.values()] };
    }
    if (statement.startsWith("DELETE FROM \"premise_v2_records\"")) {
      this.records.clear();
      this.events.clear();
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

const snapshot = await store.snapshot(at);
await store.restore(snapshot);
assert.deepEqual(await store.get(envelope.memoryId), { envelope, content: { answer: 42 } });
assert.equal((await store.listEvents()).length, 1);
console.log("store-postgres runtime tests passed");
