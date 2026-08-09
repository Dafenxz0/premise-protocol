import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqlitePremiseIndex } from "../dist/index.js";

const dir = mkdtempSync(path.join(tmpdir(), "premise-index-"));
const filename = path.join(dir, "metadata.sqlite");
const at = "2026-08-09T19:20:00Z";
const envelope = { specVersion: "premise/0.1", memoryId: "memory:sqlite", provenance: [{ sourceUri: "memory://sqlite", observedAt: at }], validity: { status: "FRESH", checkedAt: at, policy: "IMMUTABLE" }, dependsOn: [] };
try {
  const first = new SqlitePremiseIndex(filename);
  first.upsertEnvelope(envelope);
  first.appendEvent({ specVersion: "premise/0.1", eventId: "event-1", type: "MemoryRegistered", occurredAt: at, memoryId: envelope.memoryId, payload: { envelope } });
  first.close();
  const second = new SqlitePremiseIndex(filename);
  assert.deepEqual(second.getEnvelope(envelope.memoryId), envelope);
  assert.deepEqual(second.listDependencies(envelope.memoryId), []);
  assert.equal(second.listEvents(envelope.memoryId).length, 1);
  second.close();
  console.log("index-sqlite tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
