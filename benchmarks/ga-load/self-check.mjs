import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const result = JSON.parse(await readFile(new URL("./results.json", import.meta.url), "utf8"));

assert.equal(result.format, "ga-reliability-benchmark/1", "unexpected benchmark format");
assert.equal(result.runner, "node-worker-threads", "runner must use Node worker_threads");
assert.equal(result.deterministicWorkload, true, "workload must be deterministic");
assert.equal(result.interpretation.universalCapacityClaim, false, "results must not claim universal capacity");
assert.equal(result.gates.correctness.passed, true, "correctness gates failed");

if (!result.load.skipped) {
  assert.equal(result.load.memoriesApplied, result.load.memoriesRequested, "load lost synthetic memories");
  assert.equal(result.load.errors.unexpected, 0, "load reported unexpected errors");
  assert.equal(result.load.errors.worker, 0, "worker error reported");
  assert.equal(result.load.errors.journal, 0, "journal error reported");
  assert.equal(result.load.errors.store, 0, "store error reported");
  assert.equal(result.load.isolation.passed, true, "tenant isolation failed");
  assert.equal(result.load.tenants.total, result.load.memoriesApplied, "tenant totals do not reconcile");
  assert.equal(result.load.journal.writes, result.load.batches, "journal writes must equal batches");
  assert.ok(result.load.journal.bytes > 0, "journal is empty");
  assert.ok(result.load.throughput.memoriesPerSecond > 0, "throughput is missing");
  assert.ok(result.load.latency.samples > 0, "latency samples are missing");
  assert.ok(result.load.latency.p50Ms <= result.load.latency.p95Ms && result.load.latency.p95Ms <= result.load.latency.p99Ms, "latency percentiles are not ordered");
  assert.ok(result.load.heap.peakBytes >= result.load.heap.beforeBytes, "heap peak is invalid");
  assert.ok(result.load.backpressure.maxInFlightBatches <= result.configuration.concurrency, "backpressure exceeded configured concurrency");
}

if (!result.reliability.skipped) {
  assert.equal(result.reliability.passed, true, "reliability scenarios failed");
  const scenarioNames = result.reliability.scenarios.map((scenario) => scenario.name);
  for (const required of ["crash-restart", "duplicate-events", "journal-corruption-truncation", "snapshot-recovery", "tenant-isolation"]) assert.ok(scenarioNames.includes(required), `missing scenario ${required}`);
  for (const scenario of result.reliability.scenarios) assert.equal(scenario.passed, true, `${scenario.name} did not pass`);
  const crash = result.reliability.scenarios.find((scenario) => scenario.name === "crash-restart");
  assert.equal(crash.replayDuplicates, result.reliability.memories, "restart replay was not idempotent");
  const damage = result.reliability.scenarios.find((scenario) => scenario.name === "journal-corruption-truncation");
  assert.equal(damage.truncatedTailIgnored, 1, "truncated journal tail was not accounted for");
  assert.equal(damage.corruptionRejected, true, "corrupt journal was not rejected");
  const snapshot = result.reliability.scenarios.find((scenario) => scenario.name === "snapshot-recovery");
  assert.equal(snapshot.recoveredMemories, result.reliability.memories, "snapshot recovery lost memories");
}

console.log(JSON.stringify({
  status: "PASS",
  profile: result.profile,
  node: result.node.version,
  loadMemories: result.load.skipped ? 0 : result.load.memoriesApplied,
  reliabilityMemories: result.reliability.skipped ? 0 : result.reliability.memories,
  correctnessGates: result.gates.correctness,
  node24Gate: result.gates.node24,
  performanceGate: result.gates.performance
}, null, 2));
