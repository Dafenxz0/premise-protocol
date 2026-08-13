import assert from "node:assert/strict";
import test from "node:test";
import { runEventContinuityBenchmark } from "./continuity.mjs";

test("ordered event continuity benchmark passes its independent process oracle", async () => {
  const result = await runEventContinuityBenchmark();
  assert.equal(result.status, "PASS");
  assert.equal(result.claims.independentOracle, true);
  assert.equal(result.claims.independentOracleProcess, true);
  assert.equal(result.claims.runtimeConnected, false);
  assert.equal(result.gates.orderedSemantics, true);
  assert.equal(result.gates.adversarialFalseFreshDetected, true);
  assert.equal(result.gates.noRuntimeClaim, true);
  assert.ok(result.rows.find(({ id }) => id === "duplicate")?.duplicatesSuppressed === 1);
});
