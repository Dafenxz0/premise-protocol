import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { arch, availableParallelism, cpus, platform, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSignedEnvelopeClient } from "./signed-envelope-client.mjs";

const FORMAT = "premise/pg-scale-benchmark/1";
const TRACE_FORMAT = "premise/pg-scale-trace/1";
const DEFAULT_MEMORIES = 1_000_000;
const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_REQUESTS = 1_000;
const DEFAULT_CONCURRENCY = 32;
const DEFAULT_MAX_P95_MS = 500;
const DEFAULT_MAX_P99_MS = 2_000;
const DEFAULT_MAX_ERROR_RATE = 0.001;
const DEFAULT_MIN_MEMORIES = 100_000;
const DEFAULT_MIN_OPERATION_REQUESTS = 100;
const OPERATIONS = Object.freeze(["retrieve", "query", "register"]);
const OPERATION_P95_MULTIPLIER = Object.freeze({ retrieve: 1, query: 1, register: 2 });

function fail(message) {
  throw new Error(message);
}

function positiveInteger(value, name, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${name} must be a positive safe integer`);
  return parsed;
}

function nonNegativeInteger(value, name, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`${name} must be a non-negative safe integer`);
  return parsed;
}

function printable(value, name, fallback) {
  const result = value ?? fallback;
  if (typeof result !== "string" || result.length === 0 || result.length > 256 || result.trim() !== result || !/^[\x21-\x7e]+$/u.test(result)) {
    fail(`${name} must be a non-empty printable value`);
  }
  return result;
}

function identifier(value, name, fallback) {
  const result = printable(value, name, fallback);
  if (!/^[a-z_][a-z0-9_]*$/u.test(result)) fail(`${name} must be a lowercase SQL identifier`);
  return result;
}

function tenantIdentifier(value, name, fallback) {
  const result = printable(value, name, fallback);
  if (result === "*") fail(`${name} cannot be a wildcard`);
  return result;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function round(value) {
  return Number(value.toFixed(3));
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return round(sorted[index]);
}

function latencySummary(values) {
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: values.length === 0 ? null : round(Math.max(...values))
  };
}

function operationSummary(results, operation) {
  const values = results.filter((result) => result.operation === operation);
  const successful = values.filter((result) => result.ok).length;
  const failed = values.length - successful;
  return {
    requests: values.length,
    successful,
    failed,
    availabilityRate: values.length === 0 ? 0 : round(successful / values.length),
    errorRate: values.length === 0 ? 1 : round(failed / values.length),
    latency: latencySummary(values.map((result) => result.durationMs))
  };
}

function summarizeResults(results) {
  const successful = results.filter((result) => result.ok).length;
  const failed = results.length - successful;
  return {
    requests: results.length,
    successful,
    failed,
    availabilityRate: results.length === 0 ? 0 : round(successful / results.length),
    errorRate: results.length === 0 ? 1 : round(failed / results.length),
    latency: latencySummary(results.map((result) => result.durationMs)),
    byOperation: Object.fromEntries(OPERATIONS.map((operation) => [operation, operationSummary(results, operation)]))
  };
}

function operationEligibility(metric, operation, config) {
  const requests = metric?.requests ?? 0;
  const successful = metric?.successful ?? 0;
  const failed = metric?.failed ?? requests - successful;
  const rawErrorRate = requests === 0 ? 1 : failed / requests;
  const p95 = metric?.latency?.p95Ms ?? null;
  const p99 = metric?.latency?.p99Ms ?? null;
  const minimumRequests = config.minOperationRequests;
  const maxP95Ms = config.maxP95Ms * (OPERATION_P95_MULTIPLIER[operation] ?? 1);
  const requestCount = { observed: requests, minimum: minimumRequests, passed: requests >= minimumRequests };
  const errorRate = {
    observed: round(rawErrorRate),
    maximum: config.maxErrorRate,
    passed: requests >= minimumRequests && rawErrorRate <= config.maxErrorRate
  };
  const p95Check = {
    observedMs: p95,
    maximumMs: maxP95Ms,
    passed: requests >= minimumRequests && p95 !== null && p95 <= maxP95Ms
  };
  const p99Check = {
    observedMs: p99,
    maximumMs: config.maxP99Ms,
    passed: requests >= minimumRequests && p99 !== null && p99 <= config.maxP99Ms
  };
  return {
    eligibleForGa: requestCount.passed && errorRate.passed && p95Check.passed && p99Check.passed,
    checks: {
      requestCount,
      errorRate,
      p95: p95Check,
      p99: p99Check
    }
  };
}

function evaluateEligibility({ stored, metrics, config }) {
  const p95 = metrics.latency.p95Ms;
  const p99 = metrics.latency.p99Ms;
  const aggregateChecks = {
    realPostgresRecords: { observed: stored, minimum: config.minMemories, passed: stored >= config.minMemories },
    requestCount: { observed: metrics.requests, minimum: config.requests, passed: metrics.requests >= config.requests },
    errorRate: { observed: metrics.errorRate, maximum: config.maxErrorRate, passed: metrics.errorRate <= config.maxErrorRate },
    p95: { observedMs: p95, maximumMs: config.maxP95Ms, passed: p95 !== null && p95 <= config.maxP95Ms },
    p99: { observedMs: p99, maximumMs: config.maxP99Ms, passed: p99 !== null && p99 <= config.maxP99Ms }
  };
  const byOperation = Object.fromEntries(OPERATIONS.map((operation) => [
    operation,
    operationEligibility(metrics.byOperation?.[operation], operation, config)
  ]));
  const aggregateEligible = Object.values(aggregateChecks).every((check) => check.passed);
  const operationsEligible = Object.values(byOperation).every((operation) => operation.eligibleForGa);
  return {
    eligibleForGa: aggregateEligible && operationsEligible,
    checks: {
      ...aggregateChecks,
      byOperation: Object.fromEntries(OPERATIONS.map((operation) => [operation, byOperation[operation].checks]))
    },
    byOperation
  };
}

function commitMetadata() {
  const value = ["PREMISE_COMMIT", "GITHUB_SHA", "CI_COMMIT_SHA", "SOURCE_COMMIT"]
    .map((name) => process.env[name])
    .find((candidate) => typeof candidate === "string" && /^[0-9a-f]{40}$/iu.test(candidate));
  return value ?? "unknown";
}

function parseArgs(argv) {
  const values = new Map();
  const allowed = new Set(["--mode", "--output", "--trace"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) fail(`unknown argument: ${argument}`);
    const [flag, inline] = argument.split("=", 2);
    if (flag === "--help") return { help: true };
    if (!allowed.has(flag)) fail(`unknown argument: ${flag}`);
    const value = inline ?? argv[++index];
    if (value === undefined || value.startsWith("--")) fail(`${flag} requires a value`);
    values.set(flag, value);
  }
  const mode = values.get("--mode") ?? "benchmark";
  if (!["seed", "benchmark"].includes(mode)) fail("--mode must be seed or benchmark");
  const output = values.get("--output");
  const trace = values.get("--trace");
  const config = {
    mode,
    databaseUrl: process.env.DATABASE_URL ?? process.env.POSTGRES_URL,
    baseUrl: process.env.PREMISE_SCALE_BASE_URL ?? "http://127.0.0.1:3000",
    tenantId: tenantIdentifier(process.env.PREMISE_SCALE_TENANT_ID, "PREMISE_SCALE_TENANT_ID", "tenant:pg-scale"),
    tablePrefix: identifier(process.env.PREMISE_TABLE_PREFIX, "PREMISE_TABLE_PREFIX", "premise_v2"),
    memories: positiveInteger(process.env.PREMISE_SCALE_MEMORIES, "PREMISE_SCALE_MEMORIES", DEFAULT_MEMORIES),
    batchSize: positiveInteger(process.env.PREMISE_SCALE_BATCH_SIZE, "PREMISE_SCALE_BATCH_SIZE", DEFAULT_BATCH_SIZE),
    requests: positiveInteger(process.env.PREMISE_SCALE_REQUESTS, "PREMISE_SCALE_REQUESTS", DEFAULT_REQUESTS),
    concurrency: positiveInteger(process.env.PREMISE_SCALE_CONCURRENCY, "PREMISE_SCALE_CONCURRENCY", DEFAULT_CONCURRENCY),
    maxP95Ms: positiveInteger(process.env.PREMISE_SCALE_MAX_P95_MS, "PREMISE_SCALE_MAX_P95_MS", DEFAULT_MAX_P95_MS),
    maxP99Ms: positiveInteger(process.env.PREMISE_SCALE_MAX_P99_MS, "PREMISE_SCALE_MAX_P99_MS", DEFAULT_MAX_P99_MS),
    maxErrorRate: Number(process.env.PREMISE_SCALE_MAX_ERROR_RATE ?? DEFAULT_MAX_ERROR_RATE),
    minMemories: positiveInteger(process.env.PREMISE_SCALE_MIN_MEMORIES, "PREMISE_SCALE_MIN_MEMORIES", DEFAULT_MIN_MEMORIES),
    minOperationRequests: positiveInteger(process.env.PREMISE_SCALE_MIN_OPERATION_REQUESTS, "PREMISE_SCALE_MIN_OPERATION_REQUESTS", DEFAULT_MIN_OPERATION_REQUESTS),
    tracePath: trace === undefined ? undefined : path.resolve(trace),
    outputPath: output === undefined ? undefined : path.resolve(output),
    requestTimeoutMs: positiveInteger(process.env.PREMISE_SCALE_REQUEST_TIMEOUT_MS, "PREMISE_SCALE_REQUEST_TIMEOUT_MS", 30_000),
    maxResponseBytes: positiveInteger(process.env.PREMISE_SCALE_MAX_RESPONSE_BYTES, "PREMISE_SCALE_MAX_RESPONSE_BYTES", 4 * 1024 * 1024)
  };
  if (typeof config.databaseUrl !== "string" || config.databaseUrl.length === 0) fail("DATABASE_URL or POSTGRES_URL must be configured");
  if (!Number.isFinite(config.maxErrorRate) || config.maxErrorRate < 0 || config.maxErrorRate > 1) fail("PREMISE_SCALE_MAX_ERROR_RATE must be a number from 0 to 1");
  if (config.batchSize > 5_000) fail("PREMISE_SCALE_BATCH_SIZE must not exceed 5000");
  return { help: false, config };
}

function usage() {
  return `Usage: node benchmarks/ga-load/postgres-scale.mjs --mode seed|benchmark [--output PATH] [--trace PATH]

This benchmark is intentionally separate from the synthetic million-memory runner.
It writes real PREMiSE records to PostgreSQL and measures the live HTTP service.
Configuration comes from PREMISE_SCALE_* environment variables.`;
}

async function openPool(databaseUrl) {
  const module = await import("pg");
  const Pool = module.Pool ?? module.default?.Pool;
  if (typeof Pool !== "function") fail("The pg driver is required for the PostgreSQL scale benchmark");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: positiveInteger(process.env.PREMISE_SCALE_DB_POOL_SIZE, "PREMISE_SCALE_DB_POOL_SIZE", 16),
    application_name: "premise-v2-ga-postgres-scale"
  });
  await pool.query("SELECT 1");
  return pool;
}

function tableNames(prefix) {
  return {
    records: quoteIdentifier(`${prefix}_records`),
    events: quoteIdentifier(`${prefix}_events`),
    snapshots: quoteIdentifier(`${prefix}_snapshots`),
    checkpoints: quoteIdentifier(`${prefix}_replay_checkpoints`),
    idempotency: quoteIdentifier(`${prefix}_http_idempotency`)
  };
}

async function setTenantContext(connection, tenantId) {
  await connection.query("SELECT set_config('premise.tenant_id', $1, false)", [tenantId]);
}

function memoryIdFor(index) {
  return `memory:pg-scale:${index.toString(36)}`;
}

function recordFor(tenantId, index, observedAt) {
  const memoryId = memoryIdFor(index);
  const sourceUri = `pg-scale://records/${index.toString(36)}`;
  const content = `PREMiSE PostgreSQL scale memory ${index}`;
  return {
    memory_id: memoryId,
    envelope_json: {
      specVersion: "premise/2",
      tenantId,
      memoryId,
      evidence: [{
        evidenceId: `evidence:${memoryId}`,
        sourceUri,
        observedAt,
        version: { scheme: "pg-scale", token: "v1" },
        validator: { id: "pg-scale", operation: "read" }
      }],
      confidence: { score: null, method: "pg-scale", assessedAt: observedAt },
      conflicts: [],
      temporal: { asOf: observedAt },
      validity: { status: "FRESH", checkedAt: observedAt, policy: "MANUAL" },
      dependsOn: [],
      signatures: []
    },
    content_json: content
  };
}

function protocolRecordFor(tenantId, index) {
  const stored = recordFor(tenantId, index, "2026-08-10T00:00:00.000Z");
  return { envelope: stored.envelope_json, content: stored.content_json };
}

async function seed(config) {
  const tables = tableNames(config.tablePrefix);
  const pool = await openPool(config.databaseUrl);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const observedAt = new Date().toISOString();
  let inserted = 0;
  try {
    const connection = await pool.connect();
    try {
      await setTenantContext(connection, config.tenantId);
      await connection.query("BEGIN");
      await connection.query(`DELETE FROM ${tables.idempotency} WHERE tenant_id = $1`, [config.tenantId]);
      await connection.query(`DELETE FROM ${tables.events} WHERE tenant_id = $1`, [config.tenantId]);
      await connection.query(`DELETE FROM ${tables.snapshots} WHERE tenant_id = $1`, [config.tenantId]);
      await connection.query(`DELETE FROM ${tables.checkpoints} WHERE tenant_id = $1`, [config.tenantId]);
      await connection.query(`DELETE FROM ${tables.records} WHERE tenant_id = $1`, [config.tenantId]);
      await connection.query("COMMIT");

      for (let start = 0; start < config.memories; start += config.batchSize) {
        const count = Math.min(config.batchSize, config.memories - start);
        const rows = Array.from({ length: count }, (_, offset) => recordFor(config.tenantId, start + offset, observedAt));
        await connection.query(`
          INSERT INTO ${tables.records}(tenant_id, memory_id, envelope_json, content_json)
          SELECT $1, row.memory_id, row.envelope_json, row.content_json
          FROM jsonb_to_recordset($2::jsonb) AS row(memory_id text, envelope_json jsonb, content_json jsonb)
          ON CONFLICT (tenant_id, memory_id) DO UPDATE SET
            envelope_json = EXCLUDED.envelope_json,
            content_json = EXCLUDED.content_json,
            updated_at = CURRENT_TIMESTAMP
        `, [config.tenantId, JSON.stringify(rows)]);
        inserted += count;
        if (inserted % Math.max(config.batchSize * 10, 10_000) === 0 || inserted === config.memories) {
          console.error(JSON.stringify({ phase: "seed", inserted, total: config.memories }));
        }
      }
      const count = await connection.query(`SELECT count(*)::bigint AS count FROM ${tables.records} WHERE tenant_id = $1`, [config.tenantId]);
      const stored = Number(count.rows[0]?.count ?? 0);
      const result = {
        schema: "premise/pg-scale-seed/1",
        format: "premise/pg-scale-seed/1",
        generatedAt: new Date().toISOString(),
        commit: commitMetadata(),
        source: { kind: "real-postgresql-compose", tablePrefix: config.tablePrefix, tenantId: config.tenantId },
        trace: { kind: "seed-batch-trace", batchSize: config.batchSize },
        configuration: { memoriesRequested: config.memories, batchSize: config.batchSize },
        stored,
        durationMs: round(performance.now() - started),
        inserted,
        ok: stored === config.memories
      };
      if (!result.ok) fail(`PostgreSQL stored ${stored} records, expected ${config.memories}`);
      return result;
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  } finally {
    await pool.end();
  }
}

function headers(config, idempotencyKey) {
  const value = {
    accept: "application/json",
    "cache-control": "no-store",
    "x-request-id": randomUUID()
  };
  if (typeof process.env.PREMISE_API_TOKEN === "string" && process.env.PREMISE_API_TOKEN.length > 0) {
    value.authorization = `Bearer ${process.env.PREMISE_API_TOKEN}`;
  }
  if (idempotencyKey !== undefined) value["idempotency-key"] = idempotencyKey;
  return value;
}

async function request(config, operation, index, sequence, signer) {
  const target = operation === "retrieve"
    ? `/v2/memories/${encodeURIComponent(memoryIdFor(index))}`
    : operation === "query" ? "/v2/query" : "/v2/memories";
  const body = operation === "query"
    ? { query: "PREMiSE PostgreSQL scale memory", options: { limit: 8 }, maxTokens: 128 }
    : operation === "register" ? (() => {
      const record = protocolRecordFor(config.tenantId, index);
      return { record: { ...record, envelope: signer === undefined ? record.envelope : signer.signEnvelope(record.envelope, { signatureId: `sig:pg-scale:${config.runId}:${sequence}`, evidenceId: record.envelope.evidence[0]?.evidenceId }) } };
    })() : undefined;
  const idempotencyKey = operation === "register" ? `pg-scale:register:${index}` : undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const started = performance.now();
  let status = 0;
  let error;
  let responseBody;
  try {
    const response = await fetch(new URL(target, `${config.baseUrl}/`), {
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers(config, idempotencyKey), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    status = response.status;
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > config.maxResponseBytes) fail("response exceeded configured safety limit");
    responseBody = text.length === 0 ? {} : JSON.parse(text);
    if (!response.ok) error = `HTTP_${response.status}`;
    else if (operation === "retrieve" && responseBody?.envelope?.memoryId !== memoryIdFor(index)) error = "RETRIEVE_CONTRACT";
    else if (operation === "query" && (!Array.isArray(responseBody?.hits) || responseBody?.context === null || typeof responseBody?.context !== "object")) error = "QUERY_CONTRACT";
    else if (operation === "register" && (responseBody?.memoryId !== memoryIdFor(index) || responseBody?.status !== "stored")) error = "REGISTER_CONTRACT";
  } catch (caught) {
    error = caught?.name === "AbortError" ? "TIMEOUT" : caught instanceof SyntaxError ? "INVALID_JSON" : caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearTimeout(timeout);
  }
  return {
    operation,
    sequence,
    index,
    status,
    ok: error === undefined,
    error,
    durationMs: round(performance.now() - started),
    at: new Date().toISOString()
  };
}

async function benchmark(config) {
  const tables = tableNames(config.tablePrefix);
  const pool = await openPool(config.databaseUrl);
  const runId = randomUUID();
  config.runId = runId;
  const environment = String(process.env.PREMISE_ENV ?? "development").trim().toLowerCase();
  const signer = await loadSignedEnvelopeClient({ required: environment === "production" || environment === "staging" || process.env.PREMISE_REQUIRE_SIGNED_ENVELOPES === "1" });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const results = [];
  let traceHandle;
  if (config.tracePath !== undefined) {
    await mkdir(path.dirname(config.tracePath), { recursive: true });
    traceHandle = config.tracePath;
  }
  try {
    const connection = await pool.connect();
    let stored;
    let database;
    try {
      await setTenantContext(connection, config.tenantId);
      const countResult = await connection.query(`SELECT count(*)::bigint AS count FROM ${tables.records} WHERE tenant_id = $1`, [config.tenantId]);
      stored = Number(countResult.rows[0]?.count ?? 0);
      const databaseResult = await connection.query("SELECT current_setting('server_version') AS version, pg_database_size(current_database())::bigint AS size");
      database = {
        engine: "PostgreSQL",
        version: databaseResult.rows[0]?.version ?? "unknown",
        databaseSizeBytes: Number(databaseResult.rows[0]?.size ?? 0)
      };
    } finally {
      connection.release();
    }
    const health = await request(config, "retrieve", 0, 0, signer);
    if (!health.ok) fail(`live API preflight failed: ${health.error ?? health.status}`);
    const next = { value: 0 };
    const worker = async () => {
      while (true) {
        const sequence = next.value;
        next.value += 1;
        if (sequence >= config.requests) return;
        const operation = sequence % 10 === 0 ? "query" : sequence % 10 === 1 ? "register" : "retrieve";
        const index = operation === "register" ? config.memories + sequence : (sequence * 7919) % Math.max(1, stored);
        const result = await request(config, operation, index, sequence, signer);
        results.push(result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(config.concurrency, config.requests) }, () => worker()));
    if (traceHandle !== undefined) {
      const trace = [...results].sort((left, right) => left.sequence - right.sequence).map((result) => JSON.stringify({ schema: TRACE_FORMAT, ...result })).join("\n");
      await writeFile(traceHandle, `${trace}\n`, "utf8");
    }
    const metrics = summarizeResults(results);
    const eligibility = evaluateEligibility({ stored, metrics, config });
    const traceDigest = traceHandle === undefined ? null : await digestFile(traceHandle);
    const report = {
      schema: FORMAT,
      format: FORMAT,
      benchmark: "postgres-production-scale",
      generatedAt: new Date().toISOString(),
      commit: commitMetadata(),
      source: {
        kind: "real-postgresql-and-live-http",
        database: "PostgreSQL",
        baseUrl: config.baseUrl,
        tenantId: config.tenantId,
        tablePrefix: config.tablePrefix
      },
      trace: { kind: "raw-jsonl", path: config.tracePath === undefined ? null : path.basename(config.tracePath), sha256: traceDigest },
      database,
      hardware: {
        platform: platform(),
        arch: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpus: cpus().length,
        availableParallelism: availableParallelism(),
        totalMemoryBytes: totalmem()
      },
      runtime: { node: process.version, heapUsedBytes: process.memoryUsage().heapUsed, rssBytes: process.memoryUsage().rss },
      signing: { required: signer !== undefined || environment === "production" || environment === "staging" || process.env.PREMISE_REQUIRE_SIGNED_ENVELOPES === "1", configured: signer !== undefined, keyId: signer?.keyId ?? null },
      startedAt,
      durationMs: round(performance.now() - started),
      configuration: {
        memoriesExpected: config.memories,
        memoriesStored: stored,
        requests: config.requests,
        concurrency: config.concurrency,
        requestTimeoutMs: config.requestTimeoutMs,
        maxP95Ms: config.maxP95Ms,
        maxP99Ms: config.maxP99Ms,
        maxErrorRate: config.maxErrorRate,
        minMemories: config.minMemories,
        operationThresholds: Object.fromEntries(OPERATIONS.map((operation) => [operation, {
          minimumRequests: config.minOperationRequests,
          maxP95Ms: config.maxP95Ms * (OPERATION_P95_MULTIPLIER[operation] ?? 1),
          maxP99Ms: config.maxP99Ms,
          maxErrorRate: config.maxErrorRate
        }]))
      },
      metrics,
      eligibility,
      interpretation: {
        workload: "Real records are read from PostgreSQL, loaded by the production-shaped PREMiSE service, then retrieved and queried over HTTP with concurrent clients.",
        claimsSupported: ["this PostgreSQL version, image, commit, workload, tenant, hardware and run"],
        claimsNotSupported: ["universal capacity", "a provider-independent SLA", "external connector correctness", "a hidden holdout accuracy claim"]
      }
    };
    if (config.outputPath !== undefined) {
      await mkdir(path.dirname(config.outputPath), { recursive: true });
      await writeFile(config.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    return report;
  } finally {
    await pool.end();
  }
}

async function digestFile(filename) {
  const { readFile } = await import("node:fs/promises");
  return `sha256:${createHash("sha256").update(await readFile(filename)).digest("hex")}`;
}

function print(result) {
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(usage());
    return;
  }
  const result = parsed.config.mode === "seed" ? await seed(parsed.config) : await benchmark(parsed.config);
  print(result);
  if (parsed.config.mode === "benchmark" && result.eligibility?.eligibleForGa !== true) process.exitCode = 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { benchmark, evaluateEligibility, parseArgs, seed, summarizeResults };
