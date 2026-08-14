import assert from "node:assert/strict";
import { PostgresValidationFlightStore, validationFlightScopeDigest } from "../../../packages/store-postgres/dist/index.js";
import { fileURLToPath } from "node:url";

const scope = {
  tenantId: "tenant:acme",
  resourceId: "github:acme/app#main",
  versionScheme: "github.commit",
  versionToken: "commit:7",
  authorizationContextDigest: "auth:read",
  policyDigest: "policy:merge",
  queryDigest: "query:pr",
  frontierDigest: "frontier:42"
};

class InMemoryPostgresAdapter {
  rows = new Map();

  async query(sql, values = []) {
    const statement = sql.replace(/\s+/gu, " ").trim();
    if (statement.startsWith("SELECT set_config") || statement.startsWith("CREATE ") || statement.startsWith("ALTER ") || statement.startsWith("DROP POLICY")) return { rows: [], rowCount: 0 };
    if (statement.startsWith("INSERT INTO")) return this.claim(values);
    if (statement.startsWith("SELECT scope_digest")) {
      const [digest, tenantId] = values;
      const row = this.rows.get(digest);
      return { rows: row !== undefined && row.tenant_id === tenantId ? [this.dbRow(row)] : [] };
    }
    if (statement.startsWith("UPDATE")) return this.complete(values);
    throw new Error(`unexpected validation-flight SQL: ${statement}`);
  }

  async transaction(action) { return action({ query: (sql, values) => this.query(sql, values) }); }

  claim(values) {
    const [digest, tenantId, scopeJson, owner, flightId, now, expiresAt] = values;
    const current = this.rows.get(digest);
    if (current !== undefined && current.expires_at > now) return { rows: [], rowCount: 0 };
    const row = {
      scope_digest: digest,
      tenant_id: tenantId,
      scope_json: JSON.parse(scopeJson),
      owner,
      flight_id: flightId,
      fencing_token: current === undefined ? 1 : current.fencing_token + 1,
      state: "IN_PROGRESS",
      receipt_json: null,
      updated_at: now,
      expires_at: expiresAt
    };
    this.rows.set(digest, row);
    return { rows: [this.dbRow(row)], rowCount: 1 };
  }

  complete(values) {
    const [digest, tenantId, owner, flightId, fencingToken, receiptJson, now, expiresAt] = values;
    const row = this.rows.get(digest);
    if (row === undefined || row.tenant_id !== tenantId || row.owner !== owner || row.flight_id !== flightId || row.fencing_token !== fencingToken || row.state !== "IN_PROGRESS" || row.expires_at <= now) return { rows: [], rowCount: 0 };
    row.state = "COMPLETED";
    row.receipt_json = JSON.parse(receiptJson);
    row.updated_at = now;
    row.expires_at = expiresAt;
    return { rows: [], rowCount: 1 };
  }

  dbRow(row) {
    return {
      scope_digest: row.scope_digest,
      tenant_id: row.tenant_id,
      scope_json: JSON.stringify(row.scope_json),
      fencing_token: String(row.fencing_token),
      state: row.state,
      receipt_json: row.receipt_json === null ? null : JSON.stringify(row.receipt_json),
      expires_at: String(row.expires_at)
    };
  }
}

function makeStore() {
  const adapter = new InMemoryPostgresAdapter();
  return { adapter, store: new PostgresValidationFlightStore(adapter, { tableName: "premise_failure_flights", defaultLeaseMs: 10, completedRetentionMs: 10 }) };
}

export async function runDistributedFailureCampaign({ mode = "offline" } = {}) {
  if (mode === "live" && (!process.env.POSTGRES_URL || !process.env.PG_TEST_DRIVER)) return { mode: "live", status: "SKIPPED", reason: "POSTGRES_URL and PG_TEST_DRIVER are required; no live claim made" };
  assert.equal(mode, "offline");
  const { adapter, store } = makeStore();
  await store.initialize();
  const counts = { leaderCrashes: 0, takeovers: 0, fencedOldLeaders: 0, completedReplays: 0, isolatedScopes: 0, timeouts: 0, aborts: 0 };

  const first = await store.claim(scope, "worker:a", "flight:a", 100);
  assert.equal(first.kind, "LEADER");
  counts.leaderCrashes += 1;
  assert.deepEqual(await store.read(scope, 105), { kind: "IN_PROGRESS", fencingToken: first.fencingToken, expiresAt: 110 });
  const replacement = await store.claim(scope, "worker:b", "flight:b", 111);
  assert.equal(replacement.kind, "LEADER");
  counts.takeovers += 1;
  assert.equal(replacement.fencingToken > first.fencingToken, true);
  assert.deepEqual(await store.complete(scope, "worker:a", "flight:a", first.fencingToken, { answer: "stale" }, 112), { kind: "REJECTED", reason: "FENCED" });
  counts.fencedOldLeaders += 1;
  assert.deepEqual(await store.complete(scope, "worker:b", "flight:b", replacement.fencingToken, { answer: "fresh" }, 112), { kind: "COMPLETED" });

  const replay = await store.claim(scope, "worker:c", "flight:c", 113);
  assert.deepEqual(replay, { kind: "COMPLETED", fencingToken: replacement.fencingToken, receipt: { answer: "fresh" } });
  counts.completedReplays += 1;

  const differentQuery = await store.claim({ ...scope, queryDigest: "query:other" }, "worker:d", "flight:d", 100);
  const otherTenant = await store.claim({ ...scope, tenantId: "tenant:other" }, "worker:e", "flight:e", 100);
  assert.equal(differentQuery.kind, "LEADER");
  assert.equal(otherTenant.kind, "LEADER");
  counts.isolatedScopes += 2;

  const waiting = await store.claim({ ...scope, resourceId: "resource:waiting" }, "worker:f", "flight:f", 100);
  assert.equal(waiting.kind, "LEADER");
  assert.deepEqual(await store.waitForCompletion({ ...scope, resourceId: "resource:waiting" }, { now: () => 100, timeoutMs: 0, pollMs: 0 }), { kind: "TIMEOUT" });
  counts.timeouts += 1;
  assert.deepEqual(await store.waitForCompletion({ ...scope, resourceId: "resource:waiting" }, { signal: { aborted: true }, timeoutMs: 10 }), { kind: "TIMEOUT" });
  counts.aborts += 1;
  assert.equal(validationFlightScopeDigest(scope).startsWith("sha256:"), true);
  await store.close();
  return { mode: "offline", status: "PASS", counts, rows: adapter.rows.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length) ?? "offline";
  const result = await runDistributedFailureCampaign({ mode });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "PASS") process.exitCode = 0;
}
