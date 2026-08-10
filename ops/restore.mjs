import { readFile } from "node:fs/promises";
import { PostgresRuntimeStore } from "@premise/store-postgres";
import { parseBackup } from "./backup-format.mjs";
import { openPgClient } from "./pg-client.mjs";

if (process.env.RESTORE_CONFIRM !== "I_UNDERSTAND_DATA_REPLACEMENT") throw new Error("Set RESTORE_CONFIRM=I_UNDERSTAND_DATA_REPLACEMENT to replace the PREMiSE v2 store");

const file = process.env.BACKUP_FILE ?? "/backup/premise-v2-latest.json";
const snapshot = parseBackup(JSON.parse(await readFile(file, "utf8")));
const client = await openPgClient();

try {
  const store = new PostgresRuntimeStore(client, {
    tablePrefix: process.env.PREMISE_TABLE_PREFIX ?? "premise_v2",
    tenantId: process.env.PREMISE_TENANT_ID ?? "tenant:local"
  });
  await store.migrate();
  await store.restore(snapshot);
  const restored = await store.snapshot(new Date().toISOString());
  if (restored.records.length !== snapshot.records.length || restored.events.length !== snapshot.events.length) throw new Error("PREMiSE restore count verification failed");
  console.log(JSON.stringify({ ok: true, tenantId: process.env.PREMISE_TENANT_ID ?? "tenant:local", records: restored.records.length, events: restored.events.length }));
} finally {
  await client.close();
}
