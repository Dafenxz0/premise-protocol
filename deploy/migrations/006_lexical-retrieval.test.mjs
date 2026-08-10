import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(new URL("./006_lexical-retrieval.sql", import.meta.url), "utf8");

assert.match(sql, /CREATE INDEX IF NOT EXISTS premise_v2_records_content_fts_idx/u);
assert.match(sql, /USING GIN/u);
assert.match(sql, /to_tsvector\('simple', content_json::text\)/u);
assert.match(sql, /INSERT INTO premise_v2_schema_migrations\(version\) VALUES \(6\)/u);
assert.doesNotMatch(sql, /CONCURRENTLY/u, "deployment migrator runs each migration in a transaction");

console.log("lexical retrieval migration contract passed");
