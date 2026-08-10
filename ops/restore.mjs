import { PostgresRuntimeStore } from "@premise/store-postgres";
import { assertExpectedBackupSha256, createIncrementalDigest, digestStoreIncrementally, parseBackupBatchSize, parseExpectedBackupSha256, restoreIncrementalBackup, restoreLegacyBackup, verifyBackupFile } from "./backup-format.mjs";
import { openPgClient } from "./pg-client.mjs";

if (process.env.RESTORE_CONFIRM !== "I_UNDERSTAND_DATA_REPLACEMENT") throw new Error("Set RESTORE_CONFIRM=I_UNDERSTAND_DATA_REPLACEMENT to replace the PREMiSE v2 store");

const file = process.env.BACKUP_FILE ?? "/backup/premise-v2-latest.ndjson";
const tenantId = process.env.PREMISE_TENANT_ID ?? "tenant:local";
const expectedSha256 = parseExpectedBackupSha256();
const verifiedSource = await verifyBackupFile(file, { expectedTenantId: tenantId });
assertExpectedBackupSha256(expectedSha256, verifiedSource.summary.sha256);
const client = await openPgClient();

try {
  const store = new PostgresRuntimeStore(client, {
    tablePrefix: process.env.PREMISE_TABLE_PREFIX ?? "premise_v2",
    tenantId
  });
  await store.migrate();
  const batchSize = parseBackupBatchSize();
  if (verifiedSource.kind === "ndjson") {
    const before = await digestStoreIncrementally(store, { batchSize, tenantId });
    const restored = await restoreIncrementalBackup(store, file, { tenantId });
    const after = await digestStoreIncrementally(store, { batchSize, tenantId, includeEventSequence: restored.eventSequences });
    if (restored.sha256 !== after.sha256 || !sameCounts(restored, after)) throw new Error("PREMiSE incremental restore integrity verification failed");
    assertExpectedBackupSha256(verifiedSource.summary.sha256, restored.sha256);
    console.log(JSON.stringify({ ok: true, format: verifiedSource.header.format, tenantId, records: after.records, events: after.events, snapshots: after.snapshots, checkpoints: after.checkpoints, httpIdempotency: after.httpIdempotency, sha256: after.sha256, sourceSha256: restored.sha256, beforeSha256: before.sha256, afterSha256: after.sha256, preflightVerified: true }));
  } else {
    const snapshot = verifiedSource.backup;
    const before = await digestStoreIncrementally(store, { batchSize, tenantId, includeAuxiliary: false, includeEventSequence: false });
    const restored = await restoreLegacyBackup(store, snapshot, { tenantId });
    const after = await digestStoreIncrementally(store, { batchSize, tenantId, includeAuxiliary: false, includeEventSequence: false });
    const sourceDigest = createIncrementalDigest();
    for (const record of snapshot.records) sourceDigest.addRecord(record);
    for (const event of snapshot.events) sourceDigest.addEvent(event);
    const source = sourceDigest.finish();
    if (source.sha256 !== after.sha256 || !sameCounts(source, after)) throw new Error("PREMiSE legacy restore integrity verification failed");
    console.log(JSON.stringify({ ok: true, format: "premise-v2-backup", tenantId, records: after.records, events: after.events, snapshots: restored.snapshots, checkpoints: restored.checkpoints, httpIdempotency: restored.httpIdempotency, sha256: after.sha256, sourceSha256: source.sha256, beforeSha256: before.sha256, afterSha256: after.sha256, preflightVerified: true }));
  }
} finally {
  await client.close();
}

function sameCounts(left, right) {
  return ["records", "events", "snapshots", "checkpoints", "httpIdempotency"].every((field) => (left[field] ?? 0) === (right[field] ?? 0));
}
