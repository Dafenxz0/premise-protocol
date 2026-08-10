import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createBackup,
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
