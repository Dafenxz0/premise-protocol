import assert from "node:assert/strict";
import { createServer } from "node:http";
import { runSoak, FORMAT } from "./runner.mjs";

const records = new Map();
let failedQuery = false;

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
  console.log(JSON.stringify({
    status: "PASS",
    requests: result.metrics.requests,
    failedRequests: result.metrics.failed,
    errorRate: result.metrics.errorRate,
    classification: result.eligibility.classification
  }, null, 2));
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
