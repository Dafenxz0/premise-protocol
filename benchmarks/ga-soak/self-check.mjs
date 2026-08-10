import assert from "node:assert/strict";
import { createServer } from "node:http";
import { classifyAcceptance, DIAGNOSTIC_FORMAT, runDiagnostic } from "./diagnostic.mjs";
import { POSTGRES_TELEMETRY_FORMAT, readPostgresTelemetry } from "./postgres-telemetry.mjs";
import { runSoak, FORMAT } from "./runner.mjs";

const records = new Map();
let failedQuery = false;

const collectedTelemetry = await readPostgresTelemetry(async (sql) => {
  if (sql.includes("server_version_num")) return { rows: [{ database: "premise", server_version_num: 160004, max_connections: 20, has_checkpointer: false, has_wal: true }] };
  if (sql.includes("pg_stat_bgwriter")) return { rows: [{ checkpoints_timed: "3", checkpoints_req: "2", checkpoints_done: null, checkpoint_write_time: "10", checkpoint_sync_time: "2", buffers_checkpoint: "40", stats_reset: null }] };
  if (sql.includes("pg_stat_wal")) return { rows: [{ wal_records: "100", wal_fpi: "4", wal_bytes: "4096", wal_buffers_full: "1", wal_write: "5", wal_sync: "5", wal_write_time: "3", wal_sync_time: "1", stats_reset: null }] };
  if (sql.includes("pg_stat_database")) return { rows: [{ xact_commit: "20", xact_rollback: "0", blks_read: "2", blks_hit: "30", tup_returned: "100", tup_fetched: "20", tup_inserted: "4", tup_updated: "1", tup_deleted: "0", temp_files: "0", temp_bytes: "0", deadlocks: "0", stats_reset: null }] };
  if (sql.includes("pg_stat_activity")) return { rows: [{ total: "2", active: "1", idle: "1", idle_in_transaction: "0", waiting: "0" }] };
  throw new Error(`unexpected telemetry SQL: ${sql}`);
});

assert.equal(collectedTelemetry.format, POSTGRES_TELEMETRY_FORMAT, "telemetry format is missing");
assert.equal(collectedTelemetry.checkpoint.view, "pg_stat_bgwriter", "PostgreSQL 16 checkpoint fallback is missing");
assert.equal(collectedTelemetry.wal.bytes, 4096, "WAL bytes were not normalized");
assert.equal(collectedTelemetry.connections.active, 1, "connection telemetry was not normalized");

const p99Failure = classifyAcceptance(
  { setup: { ok: true }, metrics: { failed: 0, latency: { p95Ms: 100, p99Ms: 2_001 } } },
  { available: true, errors: [], summary: { statsResetDetected: false, checkpoint: { totalTimeMs: 0, timeShareOfWindow: 0 }, connections: { peakUtilization: 0 } } }
);
assert.equal(p99Failure.classification, "latency-gate-failed", "diagnostic must enforce the public p99 gate");
assert.equal(p99Failure.evidence.observedP99Ms, 2_001, "p99 evidence is missing");

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  try {
    if (request.method === "GET" && url.pathname === "/readyz") {
      json(response, 200, { ok: true, ready: true, checks: { process: "ok", store: "ok" } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v2/capabilities") {
      json(response, 200, { specVersion: "premise/2", capabilities: ["RECORD", "RETRIEVAL"] });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v2/memories") {
      const input = await bodyOf(request);
      const record = input.record;
      records.set(record.envelope.memoryId, record);
      json(response, 201, { memoryId: record.envelope.memoryId, status: "stored" });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/v2/memories/")) {
      const memoryId = decodeURIComponent(url.pathname.slice("/v2/memories/".length));
      const record = records.get(memoryId);
      if (record === undefined) {
        json(response, 404, { error: "memory not found" });
        return;
      }
      json(response, 200, record);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v2/query") {
      if (!failedQuery) {
        failedQuery = true;
        json(response, 503, { error: "intentional self-check failure" });
        return;
      }
      json(response, 200, { hits: [], context: { selected: [] } });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v2/source-changed") {
      json(response, 202, { affected: [] });
      return;
    }
    json(response, 404, { error: "not found" });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object" && address.port > 0, "fixture server did not bind");

try {
  const result = await runSoak({
    baseUrl: `http://127.0.0.1:${address.port}`,
    durationMs: 250,
    concurrency: 3,
    requestTimeoutMs: 1_000,
    seedCount: 2,
    operations: ["health", "capabilities", "register", "retrieve", "query", "source-changed"],
    tenantId: "tenant:self-check",
    output: null,
    runId: "self-check"
  });

  assert.equal(result.format, FORMAT, "unexpected benchmark format");
  assert.equal(result.setup.ok, true, "fixture setup failed");
  assert.ok(result.metrics.requests > 0, "runner made no measured requests");
  assert.equal(result.metrics.requests, result.metrics.successful + result.metrics.failed, "request totals do not reconcile");
  assert.ok(result.metrics.latency.observations > 0, "latency observations are missing");
  assert.ok(result.metrics.latency.p50Ms <= result.metrics.latency.p95Ms, "p50 must not exceed p95");
  assert.ok(result.metrics.latency.p95Ms <= result.metrics.latency.p99Ms, "p95 must not exceed p99");
  assert.equal(result.eligibility.checks.latencyP95.passed, true, "fixture p95 should satisfy the public latency gate");
  assert.equal(result.eligibility.checks.latencyP99.passed, true, "fixture p99 should satisfy the public latency gate");
  assert.equal(result.eligibility.thresholds.maximumP95Ms, 500, "p95 threshold drifted from the public GA contract");
  assert.equal(result.eligibility.thresholds.maximumP99Ms, 2_000, "p99 threshold drifted from the public GA contract");
  assert.ok(result.metrics.errors.total >= 1, "fixture error was not recorded");
  assert.ok(result.metrics.errorRate > 0, "error rate did not reflect fixture error");
  assert.equal(result.eligibility.eligibleForGa, false, "short fixture run must not be GA eligible");
  assert.equal(result.eligibility.sampleType, "smoke", "short fixture run must be smoke");
  assert.equal(result.eligibility.classification, "smoke-only", "short fixture run must be marked smoke-only");
  assert.ok(result.hardware.logicalCpus > 0, "hardware metadata is missing CPU count");
  assert.ok(result.commit.value.length > 0, "commit metadata is missing");

  const diagnosticSamples = [
    {
      format: POSTGRES_TELEMETRY_FORMAT,
      capturedAt: "2026-08-10T00:00:00.000Z",
      database: "premise",
      serverVersionNum: 160004,
      checkpoint: { view: "pg_stat_bgwriter", timed: 10, requested: 1, completed: null, writeTimeMs: 0, syncTimeMs: 0, buffers: 0, statsResetAt: null },
      wal: { records: 10, fpi: 0, bytes: 100, buffersFull: 0, writes: 1, syncs: 1, writeTimeMs: 0, syncTimeMs: 0, statsResetAt: null },
      databaseStats: { commits: 1, rollbacks: 0, blocksRead: 0, blocksHit: 1, tuplesReturned: 1, tuplesFetched: 1, tuplesInserted: 1, tuplesUpdated: 0, tuplesDeleted: 0, tempFiles: 0, tempBytes: 0, deadlocks: 0, statsResetAt: null },
      connections: { max: 20, total: 2, active: 1, idle: 1, idleInTransaction: 0, waiting: 0 }
    },
    {
      format: POSTGRES_TELEMETRY_FORMAT,
      capturedAt: "2026-08-10T00:00:00.250Z",
      database: "premise",
      serverVersionNum: 160004,
      checkpoint: { view: "pg_stat_bgwriter", timed: 10, requested: 2, completed: null, writeTimeMs: 220, syncTimeMs: 80, buffers: 20, statsResetAt: null },
      wal: { records: 30, fpi: 2, bytes: 50_000, buffersFull: 2, writes: 4, syncs: 4, writeTimeMs: 20, syncTimeMs: 5, statsResetAt: null },
      databaseStats: { commits: 5, rollbacks: 0, blocksRead: 1, blocksHit: 4, tuplesReturned: 5, tuplesFetched: 5, tuplesInserted: 4, tuplesUpdated: 1, tuplesDeleted: 0, tempFiles: 0, tempBytes: 0, deadlocks: 0, statsResetAt: null },
      connections: { max: 20, total: 3, active: 2, idle: 1, idleInTransaction: 0, waiting: 1 }
    }
  ];
  let diagnosticSampleIndex = 0;
  const diagnostic = await runDiagnostic({
    baseUrl: `http://127.0.0.1:${address.port}`,
    durationMs: 100,
    concurrency: 2,
    requestTimeoutMs: 1_000,
    seedCount: 1,
    operations: ["register", "retrieve", "query"],
    tenantId: "tenant:diagnostic-self-check",
    runId: "diagnostic-self-check",
    output: null,
    diagnosticOutput: null,
    telemetryIntervalMs: 10_000,
    telemetry: { snapshot: async () => diagnosticSamples[Math.min(diagnosticSampleIndex++, diagnosticSamples.length - 1)] }
  });
  assert.equal(diagnostic.format, DIAGNOSTIC_FORMAT, "unexpected diagnostic format");
  assert.equal(diagnostic.postgresTelemetry.available, true, "diagnostic telemetry was not captured");
  assert.equal(diagnostic.postgresTelemetry.summary.checkpoint.totalTimeMs, 300, "checkpoint delta was not calculated");
  assert.equal(diagnostic.acceptance.passed, false, "checkpoint-dominated fixture must fail acceptance");
  assert.equal(diagnostic.acceptance.classification, "checkpoint-dominated", "checkpoint failure classification is not actionable");
  assert.ok(diagnostic.acceptance.actions.length >= 2, "checkpoint failure needs remediation actions");
  for (const [operation, metrics] of Object.entries(diagnostic.metrics.byOperation)) {
    assert.ok(metrics.latency.observations > 0, `${operation} latency evidence is missing`);
  }
  console.log(JSON.stringify({
    status: "PASS",
    requests: result.metrics.requests,
    failedRequests: result.metrics.failed,
    errorRate: result.metrics.errorRate,
    classification: result.eligibility.classification,
    diagnosticClassification: diagnostic.acceptance.classification
  }, null, 2));
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
