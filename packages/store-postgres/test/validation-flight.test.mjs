import assert from "node:assert/strict";
import test from "node:test";
import { PostgresValidationFlightStore, validationFlightScopeDigest } from "../dist/index.js";

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

class ScriptedPostgres {
  queries = [];
  insertRows = [];
  selectRows = [];
  updateResults = [];

  async query(sql, values = []) {
    const statement = sql.replace(/\s+/gu, " ").trim();
    this.queries.push({ statement, values: [...values] });
    if (statement.startsWith("SELECT set_config") || statement.startsWith("CREATE ") || statement.startsWith("ALTER ") || statement.startsWith("DROP POLICY")) return { rows: [] };
    if (statement.startsWith("INSERT INTO")) return { rows: this.insertRows.shift() ?? [], rowCount: 1 };
    if (statement.startsWith("SELECT scope_digest")) return { rows: this.selectRows.shift() ?? [] };
    if (statement.startsWith("UPDATE")) return this.updateResults.shift() ?? { rows: [], rowCount: 0 };
    throw new Error(`Unexpected SQL: ${statement}`);
  }

  async transaction(action) {
    return action({ query: (sql, values) => this.query(sql, values) });
  }
}

function row({ state = "IN_PROGRESS", token = "1", expiresAt = "1100", receipt = null } = {}) {
  return {
    scope_digest: validationFlightScopeDigest(scope),
    tenant_id: scope.tenantId,
    scope_json: JSON.stringify(scope),
    fencing_token: token,
    state,
    receipt_json: receipt === null ? null : JSON.stringify(receipt),
    expires_at: expiresAt
  };
}

function harness() {
  const client = new ScriptedPostgres();
  const store = new PostgresValidationFlightStore(client, { tableName: "premise_test_validation_flights" });
  return { client, store };
}

test("PostgreSQL flight store fences leaders, joins followers and returns completed receipts", async () => {
  const { client, store } = harness();
  await store.initialize();
  client.insertRows.push([row()]);
  const leader = await store.claim(scope, "agent:a", "flight:a", 1000, 100);
  assert.deepEqual(leader, { kind: "LEADER", fencingToken: 1, expiresAt: 1100 });

  client.insertRows.push([]);
  client.selectRows.push([row()]);
  assert.deepEqual(await store.claim(scope, "agent:b", "flight:b", 1050, 100), { kind: "FOLLOWER", fencingToken: 1, expiresAt: 1100 });

  client.updateResults.push({ rows: [], rowCount: 0 });
  client.selectRows.push([row()]);
  assert.deepEqual(await store.complete(scope, "agent:a", "flight:a", 2, { answer: 42 }, 1050), { kind: "REJECTED", reason: "FENCED" });

  client.insertRows.push([row({ token: "2", expiresAt: "1200" })]);
  assert.deepEqual(await store.claim(scope, "agent:b", "flight:b", 1100, 100), { kind: "LEADER", fencingToken: 2, expiresAt: 1200 });

  client.updateResults.push({ rows: [], rowCount: 0 });
  client.selectRows.push([row({ token: "2", expiresAt: "1200" })]);
  assert.deepEqual(await store.complete(scope, "agent:a", "flight:a", 1, { answer: 41 }, 1110), { kind: "REJECTED", reason: "FENCED" });

  client.updateResults.push({ rows: [], rowCount: 1 });
  assert.deepEqual(await store.complete(scope, "agent:b", "flight:b", 2, { answer: 42 }, 1110), { kind: "COMPLETED" });

  client.selectRows.push([row({ state: "COMPLETED", token: "2", expiresAt: "1210", receipt: { answer: 42 } })]);
  assert.deepEqual(await store.read(scope, 1111), { kind: "COMPLETED", fencingToken: 2, receipt: { answer: 42 } });
  client.selectRows.push([row({ state: "COMPLETED", token: "2", expiresAt: "1210", receipt: { answer: 42 } })]);
  assert.deepEqual(await store.waitForCompletion(scope, { now: () => 1111, timeoutMs: 20, pollMs: 0 }), { kind: "COMPLETED", fencingToken: 2, receipt: { answer: 42 } });
  assert.deepEqual(client.queries.find(({ statement }) => statement.startsWith("SELECT set_config"))?.values, [scope.tenantId]);
});

test("invalid flight scope and receipts fail closed", async () => {
  const { store } = harness();
  assert.deepEqual(await store.claim({ ...scope, policyDigest: "" }, "agent:a", "flight:a", 1000), { kind: "REJECTED", reason: "INVALID" });
  assert.deepEqual(await store.complete(scope, "agent:a", "flight:a", 1, undefined, 1000), { kind: "REJECTED", reason: "INVALID" });
});

console.log("store-postgres validation flight tests passed");
