import { openPgClient } from "../../../ops/pg-client.mjs";

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
function ident(value, name) {
  if (typeof value !== "string" || !identifier.test(value)) throw new Error(`${name} must be a simple SQL identifier`);
  return `"${value}"`;
}

export function livePostgresConfig(env = process.env) {
  if (!env.DATABASE_URL || env.DATABASE_URL.startsWith("__")) return { status: "NOT_RUN", reason: "DATABASE_URL is not configured" };
  if (!env.PREMISE_PG_TABLE || !env.PREMISE_PG_ID || !env.PREMISE_PG_VERSION_COLUMN) return { status: "NOT_RUN", reason: "PREMISE_PG_TABLE, PREMISE_PG_ID and PREMISE_PG_VERSION_COLUMN are required" };
  return { status: "READY", table: env.PREMISE_PG_TABLE, id: env.PREMISE_PG_ID, versionColumn: env.PREMISE_PG_VERSION_COLUMN, payloadColumn: env.PREMISE_PG_PAYLOAD_COLUMN || "payload" };
}

export async function openPostgresReadWorld({ table, id, versionColumn, payloadColumn = "payload", clientFactory = openPgClient } = {}) {
  const tableSql = ident(table, "table");
  const idSql = ident("id", "id column");
  const versionSql = ident(versionColumn, "versionColumn");
  const payloadSql = ident(payloadColumn, "payloadColumn");
  const db = await clientFactory();
  let closed = false;
  async function read() {
    if (closed) throw new Error("PostgreSQL world is closed");
    const result = await db.query(`SELECT ${idSql} AS id, ${versionSql}::text AS version, ${payloadSql} AS payload FROM ${tableSql} WHERE ${idSql} = $1`, [id]);
    if (result.rows.length !== 1) return { available: false, version: null, content: null };
    const row = result.rows[0];
    return { available: true, version: String(row.version), content: row.payload, observedAt: new Date().toISOString() };
  }
  return {
    read,
    async actIfVersion(expectedVersion, payload) {
      const result = await db.transaction(async (transaction) => transaction.query(`UPDATE ${tableSql} SET ${payloadSql} = $1 WHERE ${idSql} = $2 AND ${versionSql}::text = $3 RETURNING ${idSql} AS id`, [payload, id, expectedVersion]));
      return { accepted: result.rowCount === 1, reason: result.rowCount === 1 ? undefined : "VERSION_MISMATCH" };
    },
    close: async () => { if (!closed) { closed = true; await db.close(); } },
    status: "READY",
    mutation: "CONTROLLED_WRITE_ONLY"
  };
}

export async function probePostgresRead(env = process.env, options = {}) {
  const config = livePostgresConfig(env);
  if (config.status !== "READY") return config;
  try {
    const world = await openPostgresReadWorld({ ...config, ...options });
    const snapshot = await world.read();
    await world.close();
    return { status: snapshot.available ? "PASS_READ_ONLY" : "NOT_RUN", reason: snapshot.available ? undefined : "configured row was not found", table: config.table };
  } catch (error) {
    return { status: "NOT_RUN", reason: error.message, table: config.table };
  }
}
