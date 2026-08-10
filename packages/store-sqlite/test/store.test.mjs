import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

try {
  await import("node:sqlite");
} catch {
  console.log("store-sqlite tests skipped: this Node runtime does not provide node:sqlite");
  process.exit(0);
}

const { SqlitePersistentStore } = await import("../dist/index.js");
const at = "2026-08-09T19:20:00Z";
const envelope = {
  specVersion: "premise/0.1",
  memoryId: "memory:sqlite-store",
  provenance: [{ sourceUri: "memory://sqlite-store", observedAt: at }],
  validity: { status: "FRESH", checkedAt: at, policy: "IMMUTABLE" },
  dependsOn: []
};
const registered = {
  specVersion: "premise/0.1",
  eventId: "event:sqlite-store:registered",
  type: "MemoryRegistered",
  occurredAt: at,
  memoryId: envelope.memoryId,
  payload: { envelope }
};

const directory = mkdtempSync(path.join(tmpdir(), "premise-store-sqlite-"));
const filename = path.join(directory, "metadata.sqlite");

try {
  const store = new SqlitePersistentStore(filename);
  store.saveEnvelope(envelope);
  assert.deepEqual(store.getEnvelope(envelope.memoryId), envelope);
  const fetched = store.getEnvelope(envelope.memoryId);
  fetched.validity.status = "INVALID";
  assert.equal(store.getEnvelope(envelope.memoryId).validity.status, "FRESH");

  assert.deepEqual(store.appendEvent(registered), registered);
  assert.throws(() => store.appendEvent(registered), /Duplicate eventId/);
  assert.deepEqual(store.history(envelope.memoryId), [registered]);

  assert.deepEqual(store.saveSnapshot({ memoryId: envelope.memoryId, sequence: 3, state: { status: "FRESH" }, updatedAt: at }), { memoryId: envelope.memoryId, sequence: 3, state: { status: "FRESH" }, updatedAt: at });
  assert.deepEqual(store.saveSnapshot({ memoryId: envelope.memoryId, sequence: 2, state: { status: "STALE" }, updatedAt: at }), { memoryId: envelope.memoryId, sequence: 3, state: { status: "FRESH" }, updatedAt: at });

  const first = store.saveIdempotency({ key: "request:sqlite:1", requestHash: "hash:1", response: { accepted: true }, createdAt: at });
  assert.deepEqual(store.saveIdempotency({ key: "request:sqlite:1", requestHash: "hash:1", response: { ignored: true }, createdAt: "2026-08-09T19:21:00Z" }), first);
  assert.throws(() => store.saveIdempotency({ key: "request:sqlite:1", requestHash: "hash:2", response: { accepted: true }, createdAt: at }), /another request/);

  store.close();
  assert.equal(store.isOpen, false);
  assert.throws(() => store.getSnapshot(envelope.memoryId), /closed/);

  const reopened = new SqlitePersistentStore(filename);
  assert.deepEqual(reopened.getEnvelope(envelope.memoryId), envelope);
  assert.deepEqual(reopened.history(envelope.memoryId), [registered]);
  assert.deepEqual(reopened.getSnapshot(envelope.memoryId), { memoryId: envelope.memoryId, sequence: 3, state: { status: "FRESH" }, updatedAt: at });
  assert.deepEqual(reopened.getIdempotency("request:sqlite:1"), first);
  reopened.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("store-sqlite tests passed");
