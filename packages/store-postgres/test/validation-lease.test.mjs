import assert from "node:assert/strict";
import test from "node:test";
import { PostgresValidationLeaseStore } from "../dist/index.js";

const scope = { tenantId: "tenant:acme", resourceId: "resource:checkout" };
const row = {
  tenant_id: scope.tenantId,
  resource_id: scope.resourceId,
  owner: "agent:a",
  lease_id: "lease:a",
  fencing_token: "7",
  acquired_at: "1000",
  renewed_at: "1000",
  expires_at: "1100"
};

class ScriptedPostgres {
  queries = [];
  insertRows = [];
  selectRows = [];
  updateRows = [];

  async query(sql, values = []) {
    const statement = sql.replace(/\s+/gu, " ").trim();
    this.queries.push({ statement, values: [...values] });
    if (statement.startsWith("SELECT set_config") || statement.startsWith("CREATE ") || statement.startsWith("ALTER ") || statement.startsWith("DROP POLICY")) return { rows: [] };
    if (statement.startsWith("INSERT INTO")) return { rows: this.insertRows.shift() ?? [], rowCount: 1 };
    if (statement.startsWith("SELECT tenant_id, resource_id")) return { rows: this.selectRows.shift() ?? [] };
    if (statement.startsWith("UPDATE")) {
      const next = this.updateRows.shift() ?? { rows: [], rowCount: 0 };
      return next;
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  }

  async transaction(action) {
    return action({ query: (sql, values) => this.query(sql, values) });
  }
}

function storeHarness() {
  const client = new ScriptedPostgres();
  const store = new PostgresValidationLeaseStore(client, { tableName: "premise_test_validation_leases" });
  return { client, store };
}

test("PostgreSQL adapter uses tenant context and returns the lease contract shapes", async () => {
  const { client, store } = storeHarness();
  await store.initialize();
  assert.ok(client.queries.some(({ statement }) => statement.includes("FORCE ROW LEVEL SECURITY")));

  client.insertRows.push([row]);
  const acquired = await store.acquire({ ...scope, owner: "agent:a", leaseId: "lease:a", expiresAt: 1100 }, 1000);
  assert.deepEqual(acquired, { kind: "ACQUIRED", lease: {
    tenantId: scope.tenantId,
    resourceId: scope.resourceId,
    owner: "agent:a",
    leaseId: "lease:a",
    fencingToken: 7,
    acquiredAt: 1000,
    renewedAt: 1000,
    expiresAt: 1100
  } });
  assert.deepEqual(client.queries.find(({ statement }) => statement.startsWith("SELECT set_config"))?.values, [scope.tenantId]);

  client.insertRows.push([]);
  client.selectRows.push([row]);
  assert.deepEqual(
    await store.acquire({ ...scope, owner: "agent:b", leaseId: "lease:b", expiresAt: 1100 }, 1000),
    { kind: "HELD", lease: acquired.lease }
  );

  client.updateRows.push({ rows: [row], rowCount: 1 });
  const renewed = await store.renew({ ...scope, owner: "agent:a", leaseId: "lease:a", fencingToken: 7, expiresAt: 1200 }, 1050);
  assert.equal(renewed.kind, "UPDATED");

  client.selectRows.push([row]);
  assert.equal((await store.validate({ ...scope, owner: "agent:a", leaseId: "lease:a", fencingToken: 7 }, 1050)).kind, "VALID");

  client.updateRows.push({ rows: [], rowCount: 1 });
  await store.release({ ...scope, owner: "agent:a", leaseId: "lease:a", fencingToken: 7 }, 1060);
  const release = client.queries.findLast(({ statement }) => statement.startsWith("UPDATE") && statement.includes("expires_at = $6"));
  assert.deepEqual(release?.values, [scope.tenantId, scope.resourceId, "agent:a", "lease:a", 7, 1060]);
});

test("PostgreSQL adapter fails closed on owner and fencing mismatches", async () => {
  const { client, store } = storeHarness();
  client.selectRows.push([{ ...row, owner: "agent:other" }]);
  assert.deepEqual(
    await store.validate({ ...scope, owner: "agent:a", leaseId: "lease:a", fencingToken: 7 }, 1050),
    { kind: "REJECTED", reason: "OWNER_MISMATCH" }
  );

  client.selectRows.push([{ ...row, fencing_token: "8" }]);
  assert.deepEqual(
    await store.validate({ ...scope, owner: "agent:a", leaseId: "lease:a", fencingToken: 7 }, 1050),
    { kind: "REJECTED", reason: "STALE_FENCING_TOKEN" }
  );
});

console.log("store-postgres validation lease adapter tests passed");
