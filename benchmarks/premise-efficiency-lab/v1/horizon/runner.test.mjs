import assert from "node:assert/strict";
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
});
