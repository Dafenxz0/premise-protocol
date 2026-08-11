const DEFAULT_POOL_SIZE = 16;

async function loadPool() {
  // Resolve the package through Node's package exports/main metadata. The pg
  // package currently exposes lib/index.js rather than a root index.js, and
  // production images intentionally keep dependency layout an implementation
  // detail.
  const module = await import("pg");
  const Pool = module.Pool ?? module.default?.Pool;
  if (typeof Pool !== "function") throw new Error("The pg driver is not available in the deployment image");
  return Pool;
}

function poolSize() {
  const value = Number.parseInt(process.env.PREMISE_DB_POOL_SIZE ?? String(DEFAULT_POOL_SIZE), 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error("PREMISE_DB_POOL_SIZE must be an integer from 1 to 100");
  return value;
}

export async function openPgClient() {
  const connectionString = process.env.DATABASE_URL;
  if (typeof connectionString !== "string" || connectionString.length === 0 || connectionString.startsWith("__")) {
    throw new Error("DATABASE_URL must be injected at runtime");
  }

  const Pool = await loadPool();
  const pool = new Pool({ connectionString, max: poolSize(), application_name: "premise-v2" });
  const query = async (sql, values = []) => {
    const result = await pool.query(sql, values);
    return { rows: result.rows, rowCount: result.rowCount };
  };

  const transaction = async (action) => {
    const connection = await pool.connect();
    const client = {
      query: async (sql, values = []) => {
        const result = await connection.query(sql, values);
        return { rows: result.rows, rowCount: result.rowCount };
      }
    };
    try {
      await connection.query("BEGIN");
      const result = await action(client);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      try { await connection.query("ROLLBACK"); } catch { /* preserve the original database error */ }
      throw error;
    } finally {
      connection.release();
    }
  };

  await query("SELECT 1");
  return {
    query,
    transaction,
    close: () => pool.end()
  };
}
