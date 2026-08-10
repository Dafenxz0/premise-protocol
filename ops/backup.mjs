import path from "node:path";
import { PostgresRuntimeStore } from "@premise/store-postgres";
import { assertExpectedBackupSha256, parseBackupBatchSize, verifyBackupFile, writeIncrementalBackupFile } from "./backup-format.mjs";
import { openPgClient } from "./pg-client.mjs";

const output = path.resolve(process.env.BACKUP_FILE ?? "/backup/premise-v2-latest.ndjson");
const tablePrefix = process.env.PREMISE_TABLE_PREFIX ?? "premise_v2";
const tenantId = process.env.PREMISE_TENANT_ID ?? "tenant:local";
const client = await openPgClient();

try {
  const store = new PostgresRuntimeStore(client, { tablePrefix, tenantId });
  const backup = await writeIncrementalBackupFile(store, output, { tenantId, capturedAt: new Date().toISOString(), batchSize: parseBackupBatchSize() });
  const verified = await verifyBackupFile(output, { expectedTenantId: tenantId });
  assertExpectedBackupSha256(backup.sha256, verified.summary.sha256, "the backup source digest");
  if (backup.records !== verified.summary.records || backup.events !== verified.summary.events || backup.snapshots !== verified.summary.snapshots || backup.checkpoints !== verified.summary.checkpoints || backup.httpIdempotency !== verified.summary.httpIdempotency) {
    throw new Error("PREMiSE backup post-write verification count mismatch");
  }
  console.log(JSON.stringify({
    ok: true,
    file: output,
    format: backup.format,
    tenantId,
    records: backup.records,
    events: backup.events,
    snapshots: backup.snapshots,
    checkpoints: backup.checkpoints,
    httpIdempotency: backup.httpIdempotency,
    sha256: backup.sha256,
    sourceSha256: backup.sha256,
    verified: true,
    verifiedSha256: verified.summary.sha256
  }));
} finally {
  await client.close();
}
