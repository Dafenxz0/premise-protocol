import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(new URL("./007_signature-replay.sql", import.meta.url), "utf8");
assert.match(sql, /CREATE TABLE IF NOT EXISTS premise_v2_signature_replays/u);
assert.match(sql, /PRIMARY KEY \(tenant_id, replay_digest\)/u);
assert.match(sql, /CREATE POLICY premise_v2_signature_replays_tenant_policy/u);
assert.match(sql, /ENABLE ROW LEVEL SECURITY/u);
assert.match(sql, /FORCE ROW LEVEL SECURITY/u);
assert.match(sql, /INSERT INTO premise_v2_schema_migrations\(version\) VALUES \(7\)/u);
console.log("signature replay migration contract passed");
