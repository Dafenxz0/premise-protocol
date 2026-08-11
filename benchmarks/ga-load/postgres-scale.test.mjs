import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEligibility, memoryIdFor, parseArgs, registerIdempotencyKey, registerMemoryId, summarizeResults } from "./postgres-scale.mjs";

function result(operation, durationMs, { ok = true, sequence = 0 } = {}) {
  return { operation, durationMs, ok, sequence };
}

function eligibilityConfig(overrides = {}) {
  return {
    minMemories: 100,
    requests: 100,
    maxP95Ms: 100,
    maxP99Ms: 200,
    maxErrorRate: 0.02,
    minOperationRequests: 1,
    ...overrides
  };
}

test("real PostgreSQL scale harness requires an explicit mode and validates bounded configuration", () => {
  const previousUrl = process.env.DATABASE_URL;
  const previousMemories = process.env.PREMISE_SCALE_MEMORIES;
  const previousMaxP95 = process.env.PREMISE_SCALE_MAX_P95_MS;
  const previousMaxP99 = process.env.PREMISE_SCALE_MAX_P99_MS;
  const previousMaxErrorRate = process.env.PREMISE_SCALE_MAX_ERROR_RATE;
  try {
    process.env.DATABASE_URL = "postgresql://benchmark:benchmark@localhost:5432/premise";
    process.env.PREMISE_SCALE_MEMORIES = "100000";
    process.env.PREMISE_SCALE_MAX_P95_MS = "321";
    process.env.PREMISE_SCALE_MAX_P99_MS = "654";
    process.env.PREMISE_SCALE_MAX_ERROR_RATE = "0.02";
    const parsed = parseArgs(["--mode", "benchmark", "--output", "report.json", "--trace", "traces.jsonl"]);
    assert.equal(parsed.config.mode, "benchmark");
    assert.equal(parsed.config.memories, 100_000);
    assert.equal(parsed.config.maxP95Ms, 321);
    assert.equal(parsed.config.maxP99Ms, 654);
    assert.equal(parsed.config.maxErrorRate, 0.02);
    assert.equal(parsed.config.outputPath.endsWith("report.json"), true);
    assert.equal(parsed.config.tracePath.endsWith("traces.jsonl"), true);
    assert.throws(() => parseArgs(["--mode", "seed", "--unknown", "value"]), /unknown argument/);
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    if (previousMemories === undefined) delete process.env.PREMISE_SCALE_MEMORIES; else process.env.PREMISE_SCALE_MEMORIES = previousMemories;
    if (previousMaxP95 === undefined) delete process.env.PREMISE_SCALE_MAX_P95_MS; else process.env.PREMISE_SCALE_MAX_P95_MS = previousMaxP95;
    if (previousMaxP99 === undefined) delete process.env.PREMISE_SCALE_MAX_P99_MS; else process.env.PREMISE_SCALE_MAX_P99_MS = previousMaxP99;
    if (previousMaxErrorRate === undefined) delete process.env.PREMISE_SCALE_MAX_ERROR_RATE; else process.env.PREMISE_SCALE_MAX_ERROR_RATE = previousMaxErrorRate;
  }
});

test("operation metrics expose independent tails while preserving aggregate metrics", () => {
  const results = [
    ...Array.from({ length: 98 }, (_, sequence) => result("retrieve", 10, { sequence })),
    result("query", 5_000, { sequence: 98 }),
    result("register", 10, { sequence: 99 })
  ];
  const metrics = summarizeResults(results);

  assert.equal(metrics.requests, 100);
  assert.equal(metrics.latency.p95Ms, 10);
  assert.equal(metrics.latency.p99Ms, 10);
  assert.equal(metrics.byOperation.retrieve.requests, 98);
  assert.equal(metrics.byOperation.query.requests, 1);
  assert.equal(metrics.byOperation.query.latency.p95Ms, 5_000);
  assert.equal(metrics.byOperation.query.latency.p99Ms, 5_000);
  assert.equal(metrics.byOperation.register.errorRate, 0);
});

test("eligibility fails when one operation breaches its tail even if aggregate tails pass", () => {
  const results = [
    ...Array.from({ length: 98 }, (_, sequence) => result("retrieve", 10, { sequence })),
    result("query", 5_000, { sequence: 98 }),
    result("register", 10, { sequence: 99 })
  ];
  const metrics = summarizeResults(results);
  const eligibility = evaluateEligibility({
    stored: 100,
    metrics,
    config: eligibilityConfig()
  });

  assert.equal(eligibility.checks.p95.passed, true);
  assert.equal(eligibility.checks.p99.passed, true);
  assert.equal(eligibility.checks.byOperation.query.p95.passed, false);
  assert.equal(eligibility.byOperation.query.eligibleForGa, false);
  assert.equal(eligibility.byOperation.retrieve.eligibleForGa, true);
  assert.equal(eligibility.eligibleForGa, false);
});

test("durable register uses an explicit two-times p95 budget", () => {
  const metrics = summarizeResults([
    result("retrieve", 10),
    result("query", 10, { sequence: 1 }),
    result("register", 150, { sequence: 2 })
  ]);
  const eligibility = evaluateEligibility({
    stored: 3,
    metrics,
    config: eligibilityConfig({ requests: 3, minMemories: 3 })
  });

  assert.equal(eligibility.checks.byOperation.register.p95.maximumMs, 200);
  assert.equal(eligibility.checks.byOperation.register.p95.passed, true);
  assert.equal(eligibility.byOperation.register.eligibleForGa, true);
});

test("recovery register idempotency keys are stable per pass and isolated across passes", () => {
  assert.equal(registerIdempotencyKey("run-a", 1000001), "pg-scale:register:run-a:1000001");
  assert.equal(registerIdempotencyKey("run-a", 1000001), registerIdempotencyKey("run-a", 1000001));
  assert.notEqual(registerIdempotencyKey("run-a", 1000001), registerIdempotencyKey("run-b", 1000001));
});

test("recovery register memory identities are isolated across passes", () => {
  assert.equal(memoryIdFor(1000001), "memory:pg-scale:lflt");
  assert.equal(registerMemoryId("run-a", 1), "memory:pg-scale:register:run-a:1");
  assert.notEqual(registerMemoryId("run-a", 1), registerMemoryId("run-b", 1));
});

test("eligibility fails closed when an operation has no raw samples", () => {
  const metrics = summarizeResults([
    result("retrieve", 10),
    result("query", 10, { sequence: 1 })
  ]);
  const eligibility = evaluateEligibility({
    stored: 2,
    metrics,
    config: eligibilityConfig({ requests: 2, minMemories: 2 })
  });

  assert.equal(metrics.byOperation.register.requests, 0);
  assert.equal(eligibility.checks.byOperation.register.requestCount.passed, false);
  assert.equal(eligibility.byOperation.register.eligibleForGa, false);
  assert.equal(eligibility.eligibleForGa, false);
});

test("operation error rate cannot be hidden by a passing aggregate error rate", () => {
  const results = [
    ...Array.from({ length: 99 }, (_, sequence) => result("retrieve", 10, { sequence })),
    result("query", 10, { ok: false, sequence: 99 }),
    result("register", 10, { sequence: 100 })
  ];
  const metrics = summarizeResults(results);
  const eligibility = evaluateEligibility({
    stored: 101,
    metrics,
    config: eligibilityConfig({ requests: 101, minMemories: 101 })
  });

  assert.equal(metrics.errorRate, 0.01);
  assert.equal(eligibility.checks.errorRate.passed, true);
  assert.equal(eligibility.checks.byOperation.query.errorRate.observed, 1);
  assert.equal(eligibility.checks.byOperation.query.errorRate.passed, false);
  assert.equal(eligibility.eligibleForGa, false);
});

console.log("postgres-scale harness tests passed");
