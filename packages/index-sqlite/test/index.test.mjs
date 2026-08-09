import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqlitePremiseIndex } from "../dist/index.js";

const at = "2026-08-09T19:20:00Z";
const envelope = {
  specVersion: "premise/0.1",
  memoryId: "memory:sqlite",
  provenance: [{ sourceUri: "memory://sqlite", observedAt: at }],
  validity: { status: "FRESH", checkedAt: at, policy: "IMMUTABLE" },
  dependsOn: []
};
const registered = {
  specVersion: "premise/0.1",
  eventId: "event:registered",
  type: "MemoryRegistered",
  occurredAt: at,
  memoryId: envelope.memoryId,
  payload: { envelope }
};
const staled = {
  specVersion: "premise/0.1",
  eventId: "event:staled",
  type: "MemoryStaled",
  occurredAt: at,
  memoryId: envelope.memoryId,
  payload: { reason: "source changed" }
};

const directory = mkdtempSync(path.join(tmpdir(), "premise-index-sqlite-"));
const filename = path.join(directory, "metadata.sqlite");

try {
  const index = new SqlitePremiseIndex(filename);
  assert.equal(index.isOpen, true);
  index.upsertEnvelope(envelope);
  assert.deepEqual(index.getEnvelope(envelope.memoryId), envelope);
  assert.equal(index.getEnvelope("memory:missing"), undefined);

  const fetched = index.getEnvelope(envelope.memoryId);
  fetched.validity.status = "INVALID";
  assert.equal(index.getEnvelope(envelope.memoryId).validity.status, "FRESH");

  assert.deepEqual(index.appendEvent(registered), registered);
  assert.deepEqual(index.appendEvent(staled), staled);
  assert.throws(() => index.appendEvent(registered), /Duplicate eventId/);
  assert.deepEqual(index.listEvents(), [registered, staled]);
  assert.deepEqual(index.history(envelope.memoryId), [registered, staled]);

  index.upsertEnvelope({
    ...envelope,
    validity: { ...envelope.validity, status: "STALE" },
    dependsOn: ["memory:support", "memory:second-support"]
  });
  assert.deepEqual(index.listDependencies(envelope.memoryId), ["memory:support", "memory:second-support"]);
  assert.equal(index.getEnvelope(envelope.memoryId).validity.status, "STALE");
  assert.deepEqual(index.history(envelope.memoryId), [registered, staled]);

  index.close();
  index.close();
  assert.equal(index.isOpen, false);
  assert.throws(() => index.listEvents(), /closed/);
  index.reopen();
  assert.equal(index.isOpen, true);
  assert.deepEqual(index.listEvents(), [registered, staled]);
  assert.deepEqual(index.listDependencies(envelope.memoryId), ["memory:support", "memory:second-support"]);
  index.close();

  const reopened = new SqlitePremiseIndex(filename);
  assert.deepEqual(reopened.history(envelope.memoryId), [registered, staled]);
  assert.equal(reopened.getEnvelope(envelope.memoryId).memoryId, envelope.memoryId);
  reopened.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("index-sqlite tests passed");
