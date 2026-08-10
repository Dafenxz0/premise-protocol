import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";
import test from "node:test";
import {
  createBackup,
  createIncrementalBackupWriter,
  inspectBackupFile,
  readIncrementalBackup,
  writeIncrementalBackupFile
} from "./backup-format.mjs";

const capturedAt = "2026-08-10T10:00:00.000Z";
const tenantId = "tenant:test";
const record = { envelope: { tenantId, memoryId: "memory:test" }, content: { answer: 42 } };
const event = { tenantId, eventId: "event:test", idempotencyKey: "request:test" };

test("writes and verifies an incremental backup without calling snapshot", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "premise-backup-"));
  try {
    let snapshotCalled = false;
    const store = {
      snapshot() {
        snapshotCalled = true;
        throw new Error("snapshot must not be called by the streaming backup");
      },
      async loadIncrementally({ onRecord, onEvent }) {
        await onRecord(record);
        await onEvent(event);
        return { records: 1, events: 1 };
      }
    };
    const file = path.join(directory, "backup.json");
    const result = await writeIncrementalBackupFile(store, file, { capturedAt, tenantId, batchSize: 1 });
    assert.equal(snapshotCalled, false);
    assert.equal(result.records, 1);
    assert.equal(result.events, 1);
    assert.equal((await inspectBackupFile(file)).kind, "ndjson");
    const records = [];
    const events = [];
    const verified = await readIncrementalBackup(file, {
      expectedTenantId: tenantId,
      onRecord: (value) => records.push(value),
      onEvent: (value) => events.push(value)
    });
    assert.deepEqual(records, [record]);
    assert.deepEqual(events, [event]);
    assert.deepEqual({ records: verified.records, events: verified.events, sha256: verified.sha256 }, { records: 1, events: 1, sha256: result.sha256 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a tampered data line and keeps legacy JSON parsing available", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "premise-backup-"));
  try {
    const store = { async loadIncrementally({ onRecord, onEvent }) { await onRecord(record); await onEvent(event); return { records: 1, events: 1 }; } };
    const file = path.join(directory, "backup.json");
    await writeIncrementalBackupFile(store, file, { capturedAt, tenantId });
    const tampered = (await readFile(file, "utf8")).replace("42", "43");
    await writeFile(file, tampered, "utf8");
    await assert.rejects(() => readIncrementalBackup(file), /checksum or count mismatch/);

    const legacy = createBackup({ format: "premise-runtime-snapshot", version: 1, capturedAt, records: [], events: [] });
    const legacyFile = path.join(directory, "legacy.json");
    await writeFile(legacyFile, `${JSON.stringify(legacy)}\n`, "utf8");
    assert.equal((await inspectBackupFile(legacyFile)).kind, "legacy");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("round-trips the complete runtime state and preserves its digest", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "premise-backup-"));
  try {
    const stream = new PassThrough();
    const chunks = [];
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => chunks.push(chunk));
    const writer = createIncrementalBackupWriter(stream, { capturedAt, tenantId });
    const completeEvent = { tenantId, eventId: "event:complete", idempotencyKey: "request:complete", occurredAt: capturedAt };
    const snapshot = { tenantId: "__all__", snapshotId: capturedAt, capturedAt, snapshot: { format: "premise-runtime-snapshot", version: 1, capturedAt, records: [record], events: [completeEvent] }, createdAt: capturedAt };
    const checkpoint = { tenantId, consumerId: "consumer:test", eventSequence: 1, updatedAt: capturedAt };
    const httpIdempotency = { tenantId, operation: "register", idempotencyKey: "http:test", requestHash: "sha256:http:test", state: "COMPLETED", leaseToken: "lease:test", statusCode: 201, response: { memoryId: "memory:test" }, responseHeaders: { "content-type": "application/json" }, createdAt: capturedAt, updatedAt: capturedAt };
    const httpInProgress = { tenantId, operation: "derive", idempotencyKey: "http:in-progress", requestHash: "sha256:http:in-progress", state: "IN_PROGRESS", leaseToken: "lease:in-progress", statusCode: null, response: null, responseHeaders: {}, createdAt: capturedAt, updatedAt: capturedAt };
    await writer.ready;
    await writer.writeRecord(record);
    await writer.writeEvent(completeEvent, 1);
    await writer.writeSnapshot(snapshot);
    await writer.writeCheckpoint(checkpoint);
    await writer.writeHttpIdempotency(httpIdempotency);
    await writer.writeHttpIdempotency(httpInProgress);
    const summary = await writer.finish();
    const file = path.join(directory, "complete.ndjson");
    await writeFile(file, chunks.join(""), "utf8");

    const restored = { records: [], events: [], snapshots: [], checkpoints: [], httpIdempotency: [] };
    const verified = await readIncrementalBackup(file, {
      expectedTenantId: tenantId,
      onRecord: (value) => restored.records.push(value),
      onEvent: (value, sequence) => restored.events.push({ value, sequence }),
      onSnapshot: (value) => restored.snapshots.push(value),
      onCheckpoint: (value) => restored.checkpoints.push(value),
      onHttpIdempotency: (value) => restored.httpIdempotency.push(value)
    });
    assert.deepEqual(restored.records, [record]);
    assert.deepEqual(restored.events, [{ value: completeEvent, sequence: 1 }]);
    assert.deepEqual(restored.snapshots, [snapshot]);
    assert.deepEqual(restored.checkpoints, [checkpoint]);
    assert.deepEqual(restored.httpIdempotency, [httpIdempotency, httpInProgress]);
    assert.deepEqual({ records: verified.records, events: verified.events, snapshots: verified.snapshots, checkpoints: verified.checkpoints, httpIdempotency: verified.httpIdempotency, sha256: verified.sha256 }, { records: 1, events: 1, snapshots: 1, checkpoints: 1, httpIdempotency: 2, sha256: summary.sha256 });

    const truncated = path.join(directory, "truncated.ndjson");
    await writeFile(truncated, chunks.filter((chunk) => !chunk.includes('"kind":"checkpoint"')).join(""), "utf8");
    await assert.rejects(() => readIncrementalBackup(truncated), /checksum or count mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
