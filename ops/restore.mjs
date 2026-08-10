import { PostgresRuntimeStore } from "@premise/store-postgres";
import { digestStoreIncrementally, inspectBackupFile, parseBackupBatchSize, readIncrementalBackup, readLegacyBackup } from "./backup-format.mjs";
import { openPgClient } from "./pg-client.mjs";

if (process.env.RESTORE_CONFIRM !== "I_UNDERSTAND_DATA_REPLACEMENT") throw new Error("Set RESTORE_CONFIRM=I_UNDERSTAND_DATA_REPLACEMENT to replace the PREMiSE v2 store");

const file = process.env.BACKUP_FILE ?? "/backup/premise-v2-latest.ndjson";
const tenantId = process.env.PREMISE_TENANT_ID ?? "tenant:local";
const backupKind = await inspectBackupFile(file);
const client = await openPgClient();

try {
  const store = new PostgresRuntimeStore(client, {
    tablePrefix: process.env.PREMISE_TABLE_PREFIX ?? "premise_v2",
    tenantId
  });
  await store.migrate();
  if (backupKind.kind === "ndjson") {
    const restored = await store.restoreIncrementally({
      source: (sink) => readIncrementalBackup(file, { expectedTenantId: tenantId, onRecord: sink.onRecord, onEvent: sink.onEvent })
    });
    const verified = await digestStoreIncrementally(store, { batchSize: parseBackupBatchSize(), tenantId });
    if (restored.sha256 !== verified.sha256 || restored.records !== verified.records || restored.events !== verified.events) throw new Error("PREMiSE incremental restore integrity verification failed");
    console.log(JSON.stringify({ ok: true, format: backupKind.header.format, tenantId, records: verified.records, events: verified.events, sha256: verified.sha256 }));
  } else {
    const snapshot = await readLegacyBackup(file);
    await store.restore(snapshot);
    const restored = await store.snapshot(new Date().toISOString());
    if (restored.records.length !== snapshot.records.length || restored.events.length !== snapshot.events.length) throw new Error("PREMiSE restore count verification failed");
    console.log(JSON.stringify({ ok: true, format: "premise-v2-backup", tenantId, records: restored.records.length, events: restored.events.length }));
  }
} finally {
  await client.close();
}
