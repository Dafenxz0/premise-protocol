import { assertExpectedBackupSha256, parseExpectedBackupSha256, verifyBackupFile } from "./backup-format.mjs";

const file = process.env.BACKUP_FILE ?? "/backup/premise-v2-latest.ndjson";
const tenantId = process.env.PREMISE_TENANT_ID;
const expected = parseExpectedBackupSha256(process.env.BACKUP_EXPECTED_SHA256 ?? process.env.RESTORE_EXPECTED_SHA256);
const verified = await verifyBackupFile(file, tenantId === undefined ? {} : { expectedTenantId: tenantId });
assertExpectedBackupSha256(expected, verified.summary.sha256);
console.log(JSON.stringify({
  ok: true,
  file,
  format: verified.kind === "ndjson" ? verified.header.format : "premise-v2-backup",
  tenantId: tenantId ?? verified.header?.tenantId ?? null,
  records: verified.summary.records,
  events: verified.summary.events,
  snapshots: verified.summary.snapshots,
  checkpoints: verified.summary.checkpoints,
  httpIdempotency: verified.summary.httpIdempotency,
  sha256: verified.summary.sha256,
  sourceSha256: verified.summary.sha256,
  verified: true
}));
