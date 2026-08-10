import { randomUUID } from "node:crypto";
import { PostgresRuntimeStore } from "@premise/store-postgres";
import { createIncrementalDigest, digestStoreIncrementally, inspectBackupFile, parseBackupBatchSize, readLegacyBackup, restoreIncrementalBackup, restoreLegacyBackup } from "./backup-format.mjs";
import { openPgClient } from "./pg-client.mjs";

const file = process.env.BACKUP_FILE ?? "/backup/premise-v2-latest.ndjson";
const tablePrefix = `premise_verify_${randomUUID().replaceAll("-", "")}`;
const tenantId = process.env.PREMISE_TENANT_ID ?? "tenant:local";
const backupKind = await inspectBackupFile(file);
const client = await openPgClient();
const store = new PostgresRuntimeStore(client, { tablePrefix, tenantId });

try {
  await store.migrate();
  const batchSize = parseBackupBatchSize();
  if (backupKind.kind === "ndjson") {
    const before = await digestStoreIncrementally(store, { batchSize, tenantId });
    const restored = await restoreIncrementalBackup(store, file, { tenantId });
    const after = await digestStoreIncrementally(store, { batchSize, tenantId, includeEventSequence: restored.eventSequences });
    if (restored.sha256 !== after.sha256 || !sameCounts(restored, after)) throw new Error("Restored PREMiSE backup does not match its source digest");
    console.log(JSON.stringify({ ok: true, format: backupKind.header.format, tenantId, verifiedIn: tablePrefix, records: after.records, events: after.events, snapshots: after.snapshots, checkpoints: after.checkpoints, httpIdempotency: after.httpIdempotency, sha256: after.sha256, sourceSha256: restored.sha256, beforeSha256: before.sha256, afterSha256: after.sha256 }));
  } else {
    const backup = await readLegacyBackup(file);
    const before = await digestStoreIncrementally(store, { batchSize, tenantId, includeAuxiliary: false, includeEventSequence: false });
    const restored = await restoreLegacyBackup(store, backup, { tenantId });
    const after = await digestStoreIncrementally(store, { batchSize, tenantId, includeAuxiliary: false, includeEventSequence: false });
    const sourceDigest = createIncrementalDigest();
    for (const record of backup.records) sourceDigest.addRecord(record);
    for (const event of backup.events) sourceDigest.addEvent(event);
    const source = sourceDigest.finish();
    if (source.sha256 !== after.sha256 || !sameCounts(source, after)) throw new Error("Restored PREMiSE backup does not match the source snapshot");
    console.log(JSON.stringify({ ok: true, format: "premise-v2-backup", tenantId, verifiedIn: tablePrefix, records: after.records, events: after.events, snapshots: restored.snapshots, checkpoints: restored.checkpoints, httpIdempotency: restored.httpIdempotency, sha256: after.sha256, sourceSha256: source.sha256, beforeSha256: before.sha256, afterSha256: after.sha256 }));
  }
} finally {
  await client.query(`DROP TABLE IF EXISTS "${tablePrefix}_http_idempotency", "${tablePrefix}_replay_checkpoints", "${tablePrefix}_snapshots", "${tablePrefix}_events", "${tablePrefix}_records", "${tablePrefix}_schema_migrations"`);
  await client.close();
}

function sameCounts(left, right) {
  return ["records", "events", "snapshots", "checkpoints", "httpIdempotency"].every((field) => (left[field] ?? 0) === (right[field] ?? 0));
}
