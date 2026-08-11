import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

export const POSTGRES_BENCHMARK_FORMAT = "premise-v2-postgres-read-only/1";
const IDENTIFIER = /^(?:[a-z_][a-z0-9_]*)(?:\.(?:[a-z_][a-z0-9_]*))?$/iu;
const WRITE_SQL = /\b(?:ALTER|CREATE|DELETE|DROP|GRANT|INSERT|TRUNCATE|UPDATE|VACUUM)\b/iu;

function sha256Text(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function round(value) {
  return Number(Number(value).toFixed(3));
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function safeSqlIdentifier(value) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error("event table must be a simple schema.table identifier without SQL expressions");
  }
  return value.split(".").map((part) => `"${part}"`).join(".");
}

export function buildReadOnlyQueries(eventTable = "premise_v2_events") {
  const quotedEventTable = safeSqlIdentifier(eventTable);
  return [
    {
      id: "postgres.transaction-read-only",
      prompt: "¿La conexión de benchmark está dentro de una transacción de solo lectura?",
      sql: "SHOW transaction_read_only",
      values: []
    },
    {
      id: "postgres.server-version",
      prompt: "¿Qué versión de PostgreSQL atiende la conexión?",
      sql: "SELECT current_setting('server_version_num') AS server_version_num",
      values: []
    },
    {
      id: "postgres.database-size",
      prompt: "¿Qué tamaño ocupa la base de datos observada?",
      sql: "SELECT current_database() AS database, pg_database_size(current_database())::bigint AS bytes",
      values: []
    },
    {
      id: "postgres.event-relation",
      prompt: "¿Existe la tabla de eventos declarada para inspección?",
      sql: "SELECT to_regclass($1) AS relation",
      values: [eventTable],
      relationProbe: true
    },
    {
      id: "postgres.event-count",
      prompt: "¿Cuántos eventos contiene la tabla declarada, si existe?",
      sql: `SELECT COUNT(*)::bigint AS count FROM ${quotedEventTable}`,
      values: [],
      optional: true
    }
  ];
}

async function loadPg() {
  try {
    return await import("pg");
  } catch {
    try {
      const deploymentRequire = createRequire(new URL("../../deploy/package.json", import.meta.url));
      return deploymentRequire("pg");
    } catch {
      throw new Error("PostgreSQL benchmark requires the existing pg driver; run it in the deployment image or install deploy/ dependencies");
    }
  }
}

function environmentValue(environment, names) {
  return names.map((name) => environment[name]).find((value) => typeof value === "string" && value.length > 0);
}

function positiveTimeout(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 120_000) throw new Error("PostgreSQL benchmark timeout must be an integer from 1 to 120000 ms");
  return parsed;
}

async function timedQuery(client, query, timeoutMs) {
  const started = performance.now();
  const result = await client.query({ text: query.sql, values: query.values, query_timeout: timeoutMs });
  const latencyMs = performance.now() - started;
  return {
    trace: {
      connector: "postgres",
      taskId: query.id,
      source: "postgres://configured-database",
      readOnly: true,
      querySha256: sha256Text(query.sql),
      requests: 1,
      responseBytes: 0,
      rows: result.rowCount ?? 0,
      latencyMs: round(latencyMs)
    },
    rows: result.rows ?? []
  };
}

export async function runPostgresReadOnly({ environment = process.env, timeoutMs = environment.PREMISE_BENCHMARK_POSTGRES_TIMEOUT_MS ?? "5000", eventTable = environment.PREMISE_BENCHMARK_POSTGRES_EVENT_TABLE ?? "premise_v2_events", seed = "premise-v2-real-world-v1" } = {}) {
  const connectionString = environmentValue(environment, ["PREMISE_BENCHMARK_POSTGRES_URL", "PREMISE_SOAK_DATABASE_URL", "DATABASE_URL", "POSTGRES_URL"]);
  if (!connectionString) throw new Error("Set PREMISE_BENCHMARK_POSTGRES_URL (or DATABASE_URL) to run the PostgreSQL benchmark");
  const queryTimeoutMs = positiveTimeout(timeoutMs);
  const queries = buildReadOnlyQueries(eventTable);
  const { Pool } = await loadPg();
  if (typeof Pool !== "function") throw new Error("The pg driver did not expose Pool");
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: queryTimeoutMs, statement_timeout: queryTimeoutMs });
  const traces = [];
  const latencies = [];
  let eventRelation;
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      for (const query of queries) {
        if (query.optional && eventRelation === null) continue;
        const observed = await timedQuery(client, query, queryTimeoutMs);
        traces.push(observed.trace);
        latencies.push(observed.trace.latencyMs);
        if (query.relationProbe) eventRelation = observed.rows[0]?.relation ?? null;
      }
      if (eventRelation === null) {
        const relationTrace = traces.find((trace) => trace.taskId === "postgres.event-relation");
        if (relationTrace) relationTrace.optionalSkipped = true;
      }
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  const writeRequests = 0;
  if (queries.some((query) => WRITE_SQL.test(query.sql))) throw new Error("PostgreSQL benchmark query set contains a write statement");
  return {
    format: POSTGRES_BENCHMARK_FORMAT,
    connector: "postgres",
    mode: "live-postgres-read-only",
    seed,
    readOnly: true,
    writeRequests,
    tasks: queries.filter((query) => !(query.optional && eventRelation === null)).map(({ id, prompt }) => ({ id, prompt, connector: "postgres", method: "SELECT" })),
    metrics: {
      requests: traces.length,
      successful: traces.length,
      failed: 0,
      availabilityRate: traces.length > 0 ? 1 : 0,
      latency: {
        p50Ms: round(percentile(latencies, 0.5)),
        p95Ms: round(percentile(latencies, 0.95)),
        p99Ms: round(percentile(latencies, 0.99)),
        observations: latencies.length
      },
      costProxy: {
        model: "read-only-query-count",
        requestUnits: traces.length,
        currency: null,
        estimatedUsd: null,
        billingEvidence: false
      }
    },
    source: {
      class: "external-postgres-read-only",
      connectionStringNotExported: true,
      eventTable: eventTable,
      eventRelationFound: eventRelation !== null && eventRelation !== undefined
    },
    traces,
    limitations: [
      "This connector campaign performs SELECT/SHOW queries inside a read-only transaction; it does not mutate or benchmark write throughput.",
      "A successful connector read proves connectivity and query safety, not PREMiSE efficacy or production capacity.",
      "Cost is a query-count proxy; no provider billing record is available."
    ]
  };
}
