import { randomUUID } from "node:crypto";
import { PostgresRuntimeStore } from "@premise/store-postgres";
import { canonicalJson, digestStoreIncrementally, inspectBackupFile, parseBackupBatchSize, readIncrementalBackup, readLegacyBackup } from "./backup-format.mjs";
import { openPgClient } from "./pg-client.mjs";

const file = process.env.BACKUP_FILE ?? "/backup/premise-v2-latest.ndjson";
const tablePrefix = `premise_verify_${randomUUID().replaceAll("-", "")}`;
const tenantId = process.env.PREMISE_TENANT_ID ?? "tenant:local";
const backupKind = await inspectBackupFile(file);
const client = await openPgClient();
const store = new PostgresRuntimeStore(client, { tablePrefix, tenantId });

try {
  await store.migrate();
  if (backupKind.kind === "ndjson") {
    const restored = await store.restoreIncrementally({
      source: (sink) => readIncrementalBackup(file, { expectedTenantId: tenantId, onRecord: sink.onRecord, onEvent: sink.onEvent })
    });
    const verified = await digestStoreIncrementally(store, { batchSize: parseBackupBatchSize(), tenantId });
    if (restored.sha256 !== verified.sha256 || restored.records !== verified.records || restored.events !== verified.events) throw new Error("Restored PREMiSE backup does not match its source digest");
    console.log(JSON.stringify({ ok: true, format: backupKind.header.format, tenantId, verifiedIn: tablePrefix, records: verified.records, events: verified.events, sha256: verified.sha256 }));
  } else {
    const backup = await readLegacyBackup(file);
    await store.restore(backup);
    const restored = await store.snapshot(new Date().toISOString());
    if (canonicalJson(restored.records) !== canonicalJson(backup.records) || canonicalJson(restored.events) !== canonicalJson(backup.events)) throw new Error("Restored PREMiSE backup does not match the source snapshot");
    console.log(JSON.stringify({ ok: true, format: "premise-v2-backup", tenantId, verifiedIn: tablePrefix, records: restored.records.length, events: restored.events.length }));
  }
} finally {
  await client.query(`DROP TABLE IF EXISTS "${tablePrefix}_http_idempotency", "${tablePrefix}_replay_checkpoints", "${tablePrefix}_snapshots", "${tablePrefix}_events", "${tablePrefix}_records", "${tablePrefix}_schema_migrations"`);
  await client.close();
}
