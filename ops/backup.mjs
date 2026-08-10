import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PostgresRuntimeStore } from "@premise/store-postgres";
import { createBackup } from "./backup-format.mjs";
import { openPgClient } from "./pg-client.mjs";

const output = path.resolve(process.env.BACKUP_FILE ?? "/backup/premise-v2-latest.json");
const tablePrefix = process.env.PREMISE_TABLE_PREFIX ?? "premise_v2";
const tenantId = process.env.PREMISE_TENANT_ID ?? "tenant:local";
const client = await openPgClient();

try {
  const store = new PostgresRuntimeStore(client, { tablePrefix, tenantId });
  const backup = createBackup(await store.snapshot(new Date().toISOString()));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, file: output, tenantId, records: backup.snapshot.records.length, events: backup.snapshot.events.length, sha256: backup.sha256 }));
} finally {
  await client.close();
}
