import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PostgresRuntimeStore } from "@premise/store-postgres";
import { canonicalJson, parseBackup } from "./backup-format.mjs";
import { openPgClient } from "./pg-client.mjs";

const file = process.env.BACKUP_FILE ?? "/backup/premise-v2-latest.json";
const backup = parseBackup(JSON.parse(await readFile(file, "utf8")));
const tablePrefix = `premise_verify_${randomUUID().replaceAll("-", "")}`;
const tenantId = process.env.PREMISE_TENANT_ID ?? "tenant:local";
const client = await openPgClient();
const store = new PostgresRuntimeStore(client, { tablePrefix, tenantId });

try {
  await store.migrate();
  await store.restore(backup);
  const restored = await store.snapshot(new Date().toISOString());
  if (canonicalJson(restored.records) !== canonicalJson(backup.records) || canonicalJson(restored.events) !== canonicalJson(backup.events)) throw new Error("Restored PREMiSE backup does not match the source snapshot");
  console.log(JSON.stringify({ ok: true, tenantId, verifiedIn: tablePrefix, records: restored.records.length, events: restored.events.length }));
} finally {
  await client.query(`DROP TABLE IF EXISTS "${tablePrefix}_events"; DROP TABLE IF EXISTS "${tablePrefix}_records"`);
  await client.close();
}
