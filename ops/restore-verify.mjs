import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { PostgresRuntimeStore } from "@premise/store-postgres";
import { assertExpectedBackupSha256, createIncrementalDigest, digestStoreIncrementally, parseBackupBatchSize, parseExpectedBackupSha256, restoreIncrementalBackup, restoreLegacyBackup, verifyBackupFile } from "./backup-format.mjs";
import { openPgClient } from "./pg-client.mjs";

const file = process.env.BACKUP_FILE ?? "/backup/premise-v2-latest.ndjson";
const tablePrefix = `premise_verify_${randomUUID().replaceAll("-", "")}`;
const tenantId = process.env.PREMISE_TENANT_ID ?? "tenant:local";
const expectedSha256 = parseExpectedBackupSha256(process.env.BACKUP_EXPECTED_SHA256 ?? process.env.RESTORE_EXPECTED_SHA256);
const verifiedSource = await verifyBackupFile(file, { expectedTenantId: tenantId });
assertExpectedBackupSha256(expectedSha256, verifiedSource.summary.sha256);
const fileSha256 = await hashFile(file);
const client = await openPgClient();
const store = new PostgresRuntimeStore(client, { tablePrefix, tenantId });

try {
  await store.migrate();
  const batchSize = parseBackupBatchSize();
  if (verifiedSource.kind === "ndjson") {
    const before = await digestStoreIncrementally(store, { batchSize, tenantId });
    const restored = await restoreIncrementalBackup(store, file, { tenantId });
    const after = await digestStoreIncrementally(store, { batchSize, tenantId, includeEventSequence: restored.eventSequences });
    if (restored.sha256 !== after.sha256 || !sameCounts(restored, after)) throw new Error("Restored PREMiSE backup does not match its source digest");
    assertExpectedBackupSha256(verifiedSource.summary.sha256, restored.sha256);
    console.log(JSON.stringify(canonicalReport({ format: verifiedSource.header.format, tenantId, verifiedIn: tablePrefix, records: after.records, events: after.events, snapshots: after.snapshots, checkpoints: after.checkpoints, httpIdempotency: after.httpIdempotency, sha256: after.sha256, sourceSha256: restored.sha256, beforeSha256: before.sha256, afterSha256: after.sha256 })));
  } else {
    const backup = verifiedSource.backup;
    const before = await digestStoreIncrementally(store, { batchSize, tenantId, includeAuxiliary: false, includeEventSequence: false });
    const restored = await restoreLegacyBackup(store, backup, { tenantId });
    const after = await digestStoreIncrementally(store, { batchSize, tenantId, includeAuxiliary: false, includeEventSequence: false });
    const sourceDigest = createIncrementalDigest();
    for (const record of backup.records) sourceDigest.addRecord(record);
    for (const event of backup.events) sourceDigest.addEvent(event);
    const source = sourceDigest.finish();
    if (source.sha256 !== after.sha256 || !sameCounts(source, after)) throw new Error("Restored PREMiSE backup does not match the source snapshot");
    console.log(JSON.stringify(canonicalReport({ format: "premise-v2-backup", tenantId, verifiedIn: tablePrefix, records: after.records, events: after.events, snapshots: restored.snapshots, checkpoints: restored.checkpoints, httpIdempotency: restored.httpIdempotency, sha256: after.sha256, sourceSha256: source.sha256, beforeSha256: before.sha256, afterSha256: after.sha256 })));
  }
} finally {
  await client.query(`DROP TABLE IF EXISTS "${tablePrefix}_signature_replays", "${tablePrefix}_http_idempotency", "${tablePrefix}_replay_checkpoints", "${tablePrefix}_snapshots", "${tablePrefix}_events", "${tablePrefix}_records", "${tablePrefix}_schema_migrations"`);
  await client.close();
}

function sameCounts(left, right) {
  return ["records", "events", "snapshots", "checkpoints", "httpIdempotency"].every((field) => (left[field] ?? 0) === (right[field] ?? 0));
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function canonicalReport(result) {
  const generatedAt = new Date().toISOString();
  const commit = process.env.PREMISE_COMMIT ?? process.env.GITHUB_SHA ?? null;
  const tracePath = basename(file);
  return {
    schema: "premise/ga-evidence/1",
    commit,
    generatedAt,
    source: { kind: "real-postgresql-backup-restore", database: "PostgreSQL", tenantId: result.tenantId },
    status: "passed",
    ok: true,
    tenantId: result.tenantId,
    backup: {
      format: result.format,
      path: tracePath,
      fileSha256: `sha256:${fileSha256}`,
      sha256: result.sourceSha256,
      records: result.records,
      events: result.events
    },
    restore: {
      verified: true,
      verifiedIn: result.verifiedIn,
      sha256: result.afterSha256,
      records: result.records,
      events: result.events
    },
    trace: { kind: "raw-jsonl", path: tracePath, sha256: `sha256:${fileSha256}` },
    counts: { snapshots: result.snapshots, checkpoints: result.checkpoints, httpIdempotency: result.httpIdempotency },
    preflightVerified: true
  };
}
