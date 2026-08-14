const postgresUrl = process.env.POSTGRES_URL;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function emit(result) {
  console.log(`RESULT ${JSON.stringify({ processId: process.pid, node: process.version, ...result })}`);
}

function safeMessage(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return typeof postgresUrl === "string" ? raw.replaceAll(postgresUrl, "<redacted>") : raw;
}

async function main() {
  if (typeof postgresUrl !== "string" || postgresUrl.length === 0) {
    emit({ status: "NOT_RUN", executed: false, reason: "POSTGRES_URL is not configured" });
    return 0;
  }

  let pg;
  try {
    pg = await import("pg");
  } catch {
    emit({ status: "FAIL", executed: true, reason: "POSTGRES_URL is configured but the optional pg package is not installed" });
    return 1;
  }
  const Pool = pg.Pool ?? pg.default?.Pool;
  if (typeof Pool !== "function") {
    emit({ status: "FAIL", executed: true, reason: "POSTGRES_URL is configured but pg.Pool is unavailable" });
    return 1;
  }

  const probeName = argument("--probe-name") ?? "adoption-reality";
  const pool = new Pool({ connectionString: postgresUrl, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 5_000, max: 1 });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN TRANSACTION READ ONLY");
    const result = await client.query("SELECT 1 AS ok, current_database() AS database_name");
    if (Number(result.rows[0]?.ok) !== 1) throw new Error("read-only PostgreSQL probe returned an unexpected value");
    await client.query("COMMIT");
    emit({
      status: "PASS",
      executed: true,
      realPostgres: true,
      readOnly: true,
      probeName,
      query: "SELECT 1 AS ok, current_database() AS database_name",
      rowCount: result.rows.length
    });
    return 0;
  } catch (error) {
    try { await client?.query("ROLLBACK"); } catch { /* preserve the connection failure */ }
    emit({ status: "FAIL", executed: true, reason: `PostgreSQL probe failed: ${safeMessage(error)}` });
    return 1;
  } finally {
    client?.release();
    await pool.end();
  }
}

process.exitCode = await main();
