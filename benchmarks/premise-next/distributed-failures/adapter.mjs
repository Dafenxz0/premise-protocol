const compactSql = (sql) => sql.replace(/\s+/gu, " ").trim();

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}
function requireTransaction(active) {
  if (!active) throw new Error("in-memory Postgres adapter query outside a transaction");
}

function rowForInsert(row) {
  return {
    fencing_token: String(row.fencingToken),
    state: row.state,
    expires_at: String(row.expiresAt),
    receipt_json: row.receiptJson
  };
}

function rowForSelect(row) {
  return {
    scope_digest: row.scopeDigest,
    tenant_id: row.tenantId,
    scope_json: row.scopeJson,
    fencing_token: String(row.fencingToken),
    state: row.state,
    receipt_json: row.receiptJson,
    expires_at: String(row.expiresAt)
  };
}

/**
 * Stateful PostgresAdapter double for the validation-flight contract.
 *
 * It recognizes only the SQL emitted by PostgresValidationFlightStore. The
 * rows, tenant setting, JSONB round-trip and transaction fence are modeled so
 * the campaign exercises the production class instead of copying its logic.
 */
export class InMemoryPostgresAdapter {
  #rows = new Map();
  #tail = Promise.resolve();
  #active = false;
  #tenantId;

  queries = [];
  tenantContexts = [];

  async query(sql, values = []) {
    requireTransaction(this.#active);
    const statement = compactSql(sql);
    const parameters = [...values];
    this.queries.push({ statement, values: parameters });

    if (statement.startsWith("SELECT set_config")) {
      const tenantId = parameters[0];
      if (typeof tenantId !== "string" || tenantId.length === 0) throw new Error("invalid tenant context");
      this.#tenantId = tenantId;
      this.tenantContexts.push(tenantId);
      return { rows: [], rowCount: 1 };
    }

    if (statement.startsWith("CREATE ") || statement.startsWith("ALTER ") || statement.startsWith("DROP POLICY")) {
      return { rows: [], rowCount: 0 };
    }

    if (statement.startsWith("INSERT INTO")) {
      const [scopeDigest, tenantId, scopeJson, owner, flightId, now, expiresAt] = parameters;
      this.#assertTenant(tenantId);
      const current = this.#rows.get(scopeDigest);
      if (current !== undefined && current.expiresAt > now) return { rows: [], rowCount: 0 };

      const fencingToken = current === undefined ? 1 : current.fencingToken + 1;
      const row = {
        scopeDigest,
        tenantId,
        scopeJson,
        owner,
        flightId,
        fencingToken,
        state: "IN_PROGRESS",
        receiptJson: null,
        updatedAt: now,
        expiresAt
      };
      this.#rows.set(scopeDigest, row);
      return { rows: [rowForInsert(row)], rowCount: 1 };
    }

    if (statement.startsWith("SELECT scope_digest")) {
      const [scopeDigest, tenantId] = parameters;
      this.#assertTenant(tenantId);
      const row = this.#rows.get(scopeDigest);
      return { rows: row === undefined || row.tenantId !== tenantId ? [] : [rowForSelect(row)] };
    }

    if (statement.startsWith("UPDATE")) {
      const [scopeDigest, tenantId, owner, flightId, fencingToken, receiptJson, now, expiresAt] = parameters;
      this.#assertTenant(tenantId);
      const row = this.#rows.get(scopeDigest);
      const matches = row !== undefined
        && row.tenantId === tenantId
        && row.owner === owner
        && row.flightId === flightId
        && row.fencingToken === fencingToken
        && row.state === "IN_PROGRESS"
        && row.expiresAt > now;
      if (!matches) return { rows: [], rowCount: 0 };
      row.state = "COMPLETED";
      row.receiptJson = JSON.stringify(JSON.parse(receiptJson));
      row.updatedAt = now;
      row.expiresAt = expiresAt;
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`unexpected SQL in in-memory Postgres adapter: ${statement}`);
  }

  async transaction(action) {
    let release;
    const previous = this.#tail;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await previous;
    this.#active = true;
    this.#tenantId = undefined;
    try {
      return await action({ query: (sql, values) => this.query(sql, values) });
    } finally {
      this.#active = false;
      this.#tenantId = undefined;
      release();
    }
  }

  async close() {}

  get rows() {
    return [...this.#rows.values()]
      .sort((left, right) => left.scopeDigest.localeCompare(right.scopeDigest))
      .map((row) => jsonClone(row));
  }

  #assertTenant(tenantId) {
    if (tenantId !== this.#tenantId) throw new Error("row-level tenant policy rejected query");
  }
}
