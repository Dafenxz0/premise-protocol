import assert from "node:assert/strict";
import { PostgresPersistentStore } from "../dist/index.js";

const at = "2026-08-09T19:20:00Z";
const envelope = {
  specVersion: "premise/0.1",
  memoryId: "memory:postgres",
  provenance: [{ sourceUri: "memory://postgres", observedAt: at }],
  validity: { status: "FRESH", checkedAt: at, policy: "IMMUTABLE" },
  dependsOn: []
};
const registered = {
  specVersion: "premise/0.1",
  eventId: "event:postgres:registered",
  type: "MemoryRegistered",
  occurredAt: at,
  memoryId: envelope.memoryId,
  payload: { envelope }
};

class InMemoryPostgresDriver {
  envelopes = new Map();
  events = [];
  snapshots = new Map();
  idempotency = new Map();
  schemaRuns = 0;
  closed = false;

  async query(sql, parameters = []) {
    const statement = sql.replace(/\s+/g, " ").trim();
    if (statement.startsWith("CREATE TABLE") || statement.startsWith("CREATE INDEX") || statement.startsWith("INSERT INTO premise_store_schema_migrations")) {
      this.schemaRuns += 1;
      return { rows: [], rowCount: 0 };
    }
    if (statement.startsWith("INSERT INTO premise_store_envelopes")) {
      this.envelopes.set(parameters[0], { envelope_json: parameters[1], updated_at: parameters[2] });
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("SELECT envelope_json FROM premise_store_envelopes WHERE")) {
      const row = this.envelopes.get(parameters[0]);
      return { rows: row === undefined ? [] : [row] };
    }
    if (statement.startsWith("SELECT envelope_json FROM premise_store_envelopes ORDER")) {
      return { rows: [...this.envelopes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row) };
    }
    if (statement.startsWith("INSERT INTO premise_store_events")) {
      if (this.events.some((event) => event.event_id === parameters[0])) return { rows: [], rowCount: 0 };
      this.events.push({ sequence: this.events.length + 1, event_id: parameters[0], memory_id: parameters[1], event_json: parameters[4] });
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("SELECT event_json FROM premise_store_events WHERE")) {
      return { rows: this.events.filter((event) => event.memory_id === parameters[0]).sort((a, b) => a.sequence - b.sequence).map((event) => ({ event_json: event.event_json })) };
    }
    if (statement.startsWith("SELECT event_json FROM premise_store_events ORDER")) {
      return { rows: this.events.sort((a, b) => a.sequence - b.sequence).map((event) => ({ event_json: event.event_json })) };
    }
    if (statement.startsWith("INSERT INTO premise_store_snapshots")) {
      const existing = this.snapshots.get(parameters[0]);
      if (existing === undefined || parameters[1] >= existing.event_sequence) {
        this.snapshots.set(parameters[0], { memory_id: parameters[0], event_sequence: parameters[1], state_json: parameters[2], updated_at: parameters[3] });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (statement.startsWith("SELECT memory_id, event_sequence, state_json, updated_at FROM premise_store_snapshots")) {
      const row = this.snapshots.get(parameters[0]);
      return { rows: row === undefined ? [] : [row] };
    }
    if (statement.startsWith("INSERT INTO premise_store_idempotency")) {
      if (this.idempotency.has(parameters[0])) return { rows: [], rowCount: 0 };
      this.idempotency.set(parameters[0], { idempotency_key: parameters[0], request_hash: parameters[1], response_json: parameters[2], created_at: parameters[3] });
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("SELECT idempotency_key")) {
      const row = this.idempotency.get(parameters[0]);
      return { rows: row === undefined ? [] : [row] };
    }
    throw new Error(`Unhandled SQL in test double: ${statement}`);
  }

  async close() {
    this.closed = true;
  }
}

const driver = new InMemoryPostgresDriver();
const store = new PostgresPersistentStore(driver);
await store.initialize();
assert.equal(driver.schemaRuns, 1);

await store.saveEnvelope(envelope);
assert.deepEqual(await store.getEnvelope(envelope.memoryId), envelope);
const fetched = await store.getEnvelope(envelope.memoryId);
fetched.validity.status = "INVALID";
assert.equal((await store.getEnvelope(envelope.memoryId)).validity.status, "FRESH");

assert.deepEqual(await store.appendEvent(registered), registered);
await assert.rejects(() => store.appendEvent(registered), /Duplicate eventId/);
assert.deepEqual(await store.history(envelope.memoryId), [registered]);

assert.deepEqual(await store.saveSnapshot({ memoryId: envelope.memoryId, sequence: 3, state: { status: "FRESH" }, updatedAt: at }), { memoryId: envelope.memoryId, sequence: 3, state: { status: "FRESH" }, updatedAt: at });
assert.deepEqual(await store.saveSnapshot({ memoryId: envelope.memoryId, sequence: 2, state: { status: "STALE" }, updatedAt: at }), { memoryId: envelope.memoryId, sequence: 3, state: { status: "FRESH" }, updatedAt: at });

const first = await store.saveIdempotency({ key: "request:1", requestHash: "hash:1", response: { accepted: true }, createdAt: at });
assert.deepEqual(await store.saveIdempotency({ key: "request:1", requestHash: "hash:1", response: { ignored: true }, createdAt: "2026-08-09T19:21:00Z" }), first);
await assert.rejects(() => store.saveIdempotency({ key: "request:1", requestHash: "hash:2", response: { accepted: true }, createdAt: at }), /another request/);

await store.close();
assert.equal(driver.closed, true);
await assert.rejects(() => store.getEnvelope(envelope.memoryId), /closed/);
console.log("store-postgres tests passed");
