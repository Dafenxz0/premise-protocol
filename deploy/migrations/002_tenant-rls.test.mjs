import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(new URL("./002_tenant-rls.sql", import.meta.url), "utf8");

assert.doesNotMatch(sql, /DO\s+\$\$[\s\S]*rolsuper[\s\S]*rolbypassrls/u, "migration DDL must not reject the bootstrap owner role");
assert.match(sql, /NOSUPERUSER[\s\S]*NOBYPASSRLS/u, "the required application role boundary must be documented");
for (const table of ["records", "events", "snapshots"]) {
  assert.match(sql, new RegExp(`ALTER TABLE premise_v2_${table} ENABLE ROW LEVEL SECURITY`, "u"));
  assert.match(sql, new RegExp(`ALTER TABLE premise_v2_${table} FORCE ROW LEVEL SECURITY`, "u"));
  assert.match(sql, new RegExp(`REVOKE ALL ON premise_v2_${table} FROM PUBLIC`, "u"));
  assert.match(sql, new RegExp(`CREATE POLICY premise_v2_${table}_tenant_policy[\\s\\S]*AS RESTRICTIVE[\\s\\S]*current_setting\\('premise\\.tenant_id', true\\)`, "u"));
}

console.log("tenant RLS migration security contract passed");
