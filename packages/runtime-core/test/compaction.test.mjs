import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryJournal,
  InMemoryRuntimeStore,
  PremiseRuntime,
  createRuntimeCheckpoint,
  journalCheckpointDigest,
  runtimeIdempotencyState
} from "../dist/index.js";

const at = "2026-08-13T00:00:00Z";
const envelope = {
  specVersion: "premise/2",
  tenantId: "tenant:a",
  memoryId: "memory:compact",
  evidence: [{ evidenceId: "e:compact", sourceUri: "file:///config", observedAt: at, version: { scheme: "file", token: "v1" }, validator: { id: "file", operation: "read" } }],
  confidence: { score: null, method: "test", assessedAt: at },
  conflicts: [],
  temporal: { asOf: at },
  validity: { status: "FRESH", checkedAt: at, policy: "MANUAL" },
  dependsOn: [],
  signatures: []
};

test("operational compaction keeps a journal and compact idempotency state", () => {
  const store = new InMemoryRuntimeStore();
  const journal = new InMemoryJournal();
  const runtime = new PremiseRuntime({ store, journal, tenantId: "tenant:a", now: () => at });
  runtime.register({ envelope, content: { value: "v1" } });
  runtime.signalSourceChanged("file:///config", { scheme: "file", token: "v2" });

  const beforeEvents = store.listEvents();
  const journalEvents = journal.readFrom(0).filter((entry) => entry.kind === "event");
  assert.equal(beforeEvents.length, 3);
  const checkpoint = createRuntimeCheckpoint({
    format: "premise-runtime-checkpoint",
    version: 1,
    capturedAt: at,
    activeRecords: store.list(),
    frontierState: { status: "FRESH" },
    incarnations: { [envelope.memoryId]: "inc:1" },
    eventCursor: journalEvents[0].cursor,
    receiptEpoch: 0,
    idempotencyState: runtimeIdempotencyState(beforeEvents),
    sourceVersions: { "file:///config": "v2" },
    dependencyState: { [envelope.memoryId]: [] }
  });
  journal.checkpoint({ checkpointId: "cp:1", cursor: checkpoint.eventCursor, digest: journalCheckpointDigest(checkpoint), state: checkpoint });
  const tail = journalEvents.slice(1).map((entry) => ({ cursor: entry.cursor, event: entry.event }));

  store.compactOperational(checkpoint, tail);
  assert.equal(store.listEvents().length, 2);
  assert.equal(journal.readFrom(0).filter((entry) => entry.kind === "event").length, 3);
  assert.equal(store.hasEvent(beforeEvents[0].idempotencyKey), true);
  assert.equal(store.getEvent(beforeEvents[0].idempotencyKey)?.type, "MemoryRegistered");
});

test("compaction prepares before commit and leaves state unchanged on injected crash", () => {
  const store = new InMemoryRuntimeStore();
  const event = {
    specVersion: "premise/2",
    tenantId: "tenant:a",
    eventId: "event:1",
    operationId: "op:1",
    idempotencyKey: "idem:1",
    requestDigest: `sha256:${"a".repeat(64)}`,
    type: "SourceChanged",
    occurredAt: at,
    payload: { sourceUri: "file:///config", version: { scheme: "file", token: "v1" } }
  };
  store.appendEvent(event);
  const checkpoint = createRuntimeCheckpoint({
    format: "premise-runtime-checkpoint",
    version: 1,
    capturedAt: at,
    activeRecords: [],
    frontierState: {},
    incarnations: {},
    eventCursor: 0,
    receiptEpoch: 0,
    idempotencyState: runtimeIdempotencyState([event]),
    sourceVersions: {},
    dependencyState: {}
  });
  const before = store.snapshot(at);
  assert.throws(() => store.compactOperational(checkpoint, [{ cursor: 1, event }], { failBeforeCommit: true }), /Injected compaction crash/);
  assert.deepEqual(store.snapshot(at), before);
});
