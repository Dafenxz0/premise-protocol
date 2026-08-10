import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openPgClient } from "./pg-client.mjs";

const defaultDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../deploy/migrations");
const directory = path.resolve(process.env.MIGRATIONS_DIR ?? defaultDirectory);
const tablePrefix = process.env.PREMISE_TABLE_PREFIX ?? "premise_v2";
if (!/^[a-z_][a-z0-9_]*$/u.test(tablePrefix)) throw new Error("PREMISE_TABLE_PREFIX must be a lowercase SQL identifier");
const migrationTable = `"${tablePrefix}_deployment_migrations"`;
const client = await openPgClient();

function migrationFiles(entries) {
  const files = entries.filter((entry) => /^\d+_[a-z0-9_-]+\.sql$/u.test(entry)).sort();
  if (files.length === 0) throw new Error(`No migration files found in ${directory}`);
  const versions = files.map((file) => Number.parseInt(file, 10));
  if (new Set(versions).size !== versions.length) throw new Error("Migration versions must be unique");
  return files.map((file, index) => ({ file, version: versions[index] }));
}

try {
  const files = migrationFiles(await readdir(directory));
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${migrationTable} (
      version INTEGER PRIMARY KEY,
      filename TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query("SELECT pg_advisory_lock(hashtextextended('premise-v2-migrations', 0))");
  try {
    for (const migration of files) {
      const sql = await readFile(path.join(directory, migration.file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query(`SELECT filename, checksum FROM ${migrationTable} WHERE version = $1`, [migration.version]);
      const row = existing.rows[0];
      if (row !== undefined) {
        if (row.filename !== migration.file || row.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${migration.file}`);
        console.log(`migration ${migration.file}: already applied`);
        continue;
      }
      await client.transaction(async (transaction) => {
        await transaction.query(sql.replaceAll("premise_v2", tablePrefix));
        await transaction.query(`INSERT INTO ${migrationTable}(version, filename, checksum) VALUES ($1, $2, $3)`, [migration.version, migration.file, checksum]);
      });
      console.log(`migration ${migration.file}: applied`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended('premise-v2-migrations', 0))");
  }
} finally {
  await client.close();
}
