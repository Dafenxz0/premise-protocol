import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileJournal, InMemoryJournal, PremiseRuntime, journalCheckpointDigest } from "../dist/index.js";

const at = "2026-08-13T00:00:00Z";
const event = (idempotencyKey, eventId = idempotencyKey, tenantId = "tenant:a") => ({
  specVersion: "premise/2",
  tenantId,
  eventId,
  operationId: `op:${eventId}`,
  idempotencyKey,
  requestDigest: `sha256:${eventId.replaceAll(/[^a-f0-9]/gu, "a").padEnd(64, "a").slice(0, 64)}`,
  type: "SourceChanged",
  occurredAt: at,
  payload: { sourceUri: "file:///config", version: { scheme: "file", token: eventId } }
});

const decision = { memoryId: "memory:1", decision: "REVALIDATE", reason: "EVENT_GAP" };

const envelope = {
  specVersion: "premise/2",
  tenantId: "tenant:a",
  memoryId: "memory:runtime",
  evidence: [{ evidenceId: "e:runtime", sourceUri: "file:///config", observedAt: at, version: { scheme: "file", token: "v1" }, validator: { id: "file", operation: "read" } }],
  confidence: { score: null, method: "test", assessedAt: at },
  conflicts: [],
  temporal: { asOf: at },
  validity: { status: "FRESH", checkedAt: at, policy: "MANUAL" },
  dependsOn: [],
  signatures: []
};

test("in-memory journal has monotonic cursors, tenant filtering, and idempotent events", () => {
  const journal = new InMemoryJournal();
  assert.equal(journal.appendEvent(event("e:1")), 1);
  assert.equal(journal.appendEvent(event("e:1")), 1);
  assert.equal(journal.appendDecision("tenant:a", decision, at), 2);
  assert.equal(journal.appendEvent(event("e:2", "e:2", "tenant:b")), 3);
  assert.deepEqual(journal.readFrom(0, { tenantId: "tenant:a" }).map((entry) => entry.cursor), [1, 2]);
  assert.deepEqual(journal.readFrom(1, { limit: 1 }).map((entry) => entry.cursor), [2]);
  assert.equal(journal.latestCursor(), 3);
  assert.throws(() => journal.appendEvent({ ...event("e:1"), requestDigest: `sha256:${"b".repeat(64)}` }), /Conflicting journal event/);
});

test("checkpoints are digest-bound and cannot move backwards", () => {
  const journal = new InMemoryJournal();
  journal.appendEvent(event("e:1"));
  const state = { activeRecords: ["memory:1"], eventCursor: 1 };
  journal.checkpoint({ checkpointId: "cp:1", cursor: 1, digest: journalCheckpointDigest(state), state });
  assert.deepEqual(journal.latestCheckpoint()?.state, state);
  assert.throws(() => journal.checkpoint({ checkpointId: "cp:bad", cursor: 1, digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000", state }), /digest/);
  assert.throws(() => journal.checkpoint({ checkpointId: "cp:old", cursor: 0, digest: journalCheckpointDigest({}), state: {} }), /backwards/);
  assert.throws(() => journal.checkpoint({ checkpointId: "cp:ahead", cursor: 2, digest: journalCheckpointDigest({}), state: {} }), /ahead/);
});

test("file journal recovers a torn final line without accepting it", () => {
  const directory = mkdtempSync(join(tmpdir(), "premise-journal-"));
  const path = join(directory, "events.jsonl");
  try {
    const first = new FileJournal(path);
    first.appendEvent(event("e:1"));
    first.appendDecision("tenant:a", decision, at);
    writeFileSync(path, `${readFileSync(path, "utf8")}\n{\"kind\":\"event\"`, "utf8");
    const recovered = new FileJournal(path);
    assert.equal(recovered.latestCursor(), 2);
    assert.deepEqual(recovered.readFrom(0).map((entry) => entry.cursor), [1, 2]);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2);
    assert.equal(recovered.appendEvent(event("e:3")), 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime sends committed events and decisions to the separate audit journal", () => {
  const journal = new InMemoryJournal();
  const runtime = new PremiseRuntime({ tenantId: "tenant:a", now: () => at, journal });
  runtime.register({ envelope, content: { value: "v1" } });
  runtime.check([envelope.memoryId]);
  assert.deepEqual(runtime.history().map((item) => item.type), ["MemoryRegistered"]);
  assert.deepEqual(journal.readFrom(0).map((entry) => entry.kind), ["event", "decision"]);
  assert.equal(runtime.eventCount(), 1);
});
