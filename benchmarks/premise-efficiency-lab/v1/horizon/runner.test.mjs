import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runLongHorizonBenchmark } from "./runner.mjs";

test("long-horizon measurement preserves active state and remains deterministic", async () => {
  const result = await runLongHorizonBenchmark({ horizons: [32, 64], worldSize: 4 });
  assert.equal(result.status, "PASS");
  assert.equal(result.claims.measurementOnly, true);
  assert.equal(result.claims.compactionImplemented, false);
  assert.equal(result.gates.independentInvariantOracle, true);
  assert.equal(result.gates.activeStatePreserved, true);
  assert.equal(result.gates.noRuntimeErrors, true);
  assert.equal(result.gates.frontierTrusted, true);
  assert.equal(result.gates.boundedReceiptCache, true);
  assert.ok(result.rows.every(({ observed }) => observed.eventCount > observed.activeRecords));
  assert.ok(result.rows.every(({ snapshotHeap }) => Number.isSafeInteger(snapshotHeap.before.heapUsedBytes) && Number.isSafeInteger(snapshotHeap.after.heapUsedBytes)));
  assert.match(result.artifactDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(result.rows.every(({ oracle }) => oracle.pass === true && /^sha256:[0-9a-f]{64}$/.test(oracle.evidenceDigest)));
  assert.doesNotMatch(JSON.stringify(result), /expectedEvents|expectedDecisions|expectedEventTypeCounts/);
  const manifest = JSON.parse(await readFile(".tmp/premise-efficiency-lab/v1/horizon/manifest.json", "utf8"));
  assert.equal(manifest.resultDigest, result.artifactDigest);
});
