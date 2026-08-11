import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const result = JSON.parse(await readFile(new URL("./results.json", import.meta.url), "utf8"));
const taskBytes = await readFile(new URL("./tasks.json", import.meta.url));
const traceBytes = await readFile(new URL("./traces.jsonl", import.meta.url));
const manifest = JSON.parse(taskBytes.toString("utf8"));
const traceLines = traceBytes.toString("utf8").trim().split(/\r?\n/u).filter(Boolean);

assert.equal(result.format, "premise-v2-real-world-benchmark/2", "unexpected real-world-v2 format");
assert.ok(result.mode === "offline-temporal-fixture" || result.mode === "live-github-readonly", "unknown benchmark mode");
assert.ok(Number.isInteger(result.tasks) && result.tasks >= 100, "at least 100 paired tasks are required");
assert.equal(manifest.format, "premise-v2-benchmark-task-manifest/1", "task manifest format is missing");
assert.equal(manifest.tasks.length, result.tasks, "task manifest count does not match result");
assert.equal(manifest.blindness.labelsExported, false, "public task manifest exports labels");
assert.equal(manifest.blindness.expectedAnswersInTaskManifest, false, "public task manifest exports expected answers");
assert.equal(manifest.blindness.candidateCanReadOracle, false, "task manifest does not declare oracle isolation");
assert.equal(result.evidence.execution.blind, true, "result is not classified as blind evaluation");
assert.equal(result.evidence.execution.labelsExported, false, "labels were exported");
assert.equal(result.evidence.taskSet.sha256, digest(taskBytes), "task manifest digest does not match bytes");
assert.equal(result.evidence.rawTrace.sha256, digest(traceBytes), "raw trace digest does not match bytes");
assert.equal(result.evidence.rawTrace.lines, traceLines.length, "raw trace line count does not match bytes");
assert.match(result.evidence.labels.sha256, /^sha256:[0-9a-f]{64}$/u, "label commitment is missing");
assert.equal(result.claims.eligibleForPublicProductClaim, false, "benchmark result overclaims product evidence");
assert.ok(Array.isArray(result.limitations) && result.limitations.length >= 3, "limitations are not explicit");

const strategies = new Map(result.strategies.map((strategy) => [strategy.strategy, strategy]));
assert.ok(strategies.has("direct-read"), "direct source control is missing");
assert.ok(strategies.has("ttl-cache-20"), "no-protocol TTL baseline is missing");
assert.ok([...strategies.values()].some((strategy) => strategy.baseline === true && strategy.protocol === "none"), "baseline without protocol is not marked");
assert.equal(result.strategies.length, 3, "paired benchmark must contain exactly three strategies");

for (const strategy of result.strategies) {
  assert.equal(strategy.tasks, result.tasks, `${strategy.strategy} task count mismatch`);
  assert.ok(strategy.baseline === true || strategy.baseline === false, `${strategy.strategy} baseline flag is missing`);
  assert.ok(strategy.protocol, `${strategy.strategy} protocol label is missing`);
  for (const field of ["precisionPer100", "requestsPer100", "responseBytesPer100", "p50Ms", "p95Ms", "p99Ms"]) assert.ok(Number.isFinite(strategy[field]), `${strategy.strategy} is missing ${field}`);
  assert.ok(strategy.freshnessPer100 === null || Number.isFinite(strategy.freshnessPer100), `${strategy.strategy} freshness is invalid`);
  assert.ok(strategy.costProxy && strategy.costProxy.billingEvidence === false, `${strategy.strategy} cost must be a proxy`);
  assert.ok(Array.isArray(strategy.traces) && strategy.traces.length === result.tasks, `${strategy.strategy} raw task coverage is incomplete`);
  for (const trace of strategy.traces) {
    for (const forbidden of ["answer", "expected", "oracle", "snapshot", "gold", "label", "truth"]) assert.equal(Object.hasOwn(trace, forbidden), false, `${strategy.strategy} trace leaks ${forbidden}`);
    assert.equal(typeof trace.precision, "boolean", `${strategy.strategy} trace precision is missing`);
    assert.ok(trace.freshness === null || typeof trace.freshness === "boolean", `${strategy.strategy} trace freshness is invalid`);
  }
}

assert.equal(traceLines.length, result.tasks * result.strategies.length + (result.connectors?.postgres?.traceCount ?? 0), "raw trace coverage does not reconcile");
for (const line of traceLines) {
  const trace = JSON.parse(line);
  for (const forbidden of ["answer", "expected", "oracle", "snapshot", "gold", "label", "truth"]) assert.equal(Object.hasOwn(trace, forbidden), false, `raw trace leaks ${forbidden}`);
}

if (result.mode === "offline-temporal-fixture") {
  const direct = strategies.get("direct-read");
  const ttl = strategies.get("ttl-cache-20");
  const premise = strategies.get("premise-event-cache");
  assert.ok(premise, "offline PREMiSE reference strategy is missing");
  assert.equal(direct.precisionPer100, 100, "direct control should be exact on the fixture");
  assert.equal(premise.precisionPer100, 100, "event invalidation reference should be exact on the fixture");
  assert.ok(ttl.precisionPer100 < 100, "TTL baseline must expose stale answers after source mutations");
  assert.equal(direct.freshnessPer100, 100, "direct control freshness is not exact");
  assert.equal(premise.freshnessPer100, 100, "event invalidation freshness is not exact");
  assert.ok(result.mutations.length > 0, "offline workload must contain source mutations");
  assert.ok(result.limitations.some((limitation) => /deterministic fixture/u.test(limitation)), "offline fixture limitation is missing");
}

if (result.mode === "live-github-readonly") {
  const direct = strategies.get("direct-read");
  assert.equal(result.source.class, "external-live-observation", "live source is not classified as external");
  assert.equal(result.source.readOnly, true, "live benchmark is not read-only");
  assert.equal(direct.requests, result.tasks, "direct-read must perform one real GitHub request per task");
  assert.ok(direct.traces.every((trace) => Number.isInteger(trace.status) && trace.status >= 200 && trace.status < 400), "direct-read traces must include successful HTTP statuses");
  assert.ok(result.source.endpointsObserved.every((endpoint) => /^sha256:[0-9a-f]{64}$/u.test(endpoint.bodySha256)), "live source body hashes are missing");
  assert.ok(result.limitations.some((limitation) => /mutation recovery/u.test(limitation)), "live mutation limitation is missing");
}

if (result.connectors?.postgres !== undefined) {
  const postgres = result.connectors.postgres;
  assert.equal(postgres.format, "premise-v2-postgres-read-only/1", "unexpected Postgres connector format");
  assert.equal(postgres.readOnly, true, "Postgres connector is not read-only");
  assert.equal(postgres.writeRequests, 0, "Postgres connector issued writes");
  assert.ok(Number.isInteger(postgres.traceCount) && postgres.traceCount > 0, "Postgres connector trace count is missing");
  assert.ok(postgres.traces === undefined, "connector traces must remain in the raw trace, not duplicate result labels");
}

console.log(`real-world-v2 self-check passed (${result.mode}; ${result.tasks} blind tasks; trace ${result.evidence.rawTrace.sha256})`);
