import path from "node:path";
import { PostgresRuntimeStore } from "@premise/store-postgres";
import { parseBackupBatchSize, writeIncrementalBackupFile } from "./backup-format.mjs";
import { openPgClient } from "./pg-client.mjs";

const output = path.resolve(process.env.BACKUP_FILE ?? "/backup/premise-v2-latest.ndjson");
const tablePrefix = process.env.PREMISE_TABLE_PREFIX ?? "premise_v2";
const tenantId = process.env.PREMISE_TENANT_ID ?? "tenant:local";
const client = await openPgClient();

try {
  const store = new PostgresRuntimeStore(client, { tablePrefix, tenantId });
  const backup = await writeIncrementalBackupFile(store, output, { tenantId, capturedAt: new Date().toISOString(), batchSize: parseBackupBatchSize() });
  console.log(JSON.stringify({ ok: true, file: output, format: backup.format, tenantId, records: backup.records, events: backup.events, sha256: backup.sha256 }));
} finally {
  await client.close();
}
