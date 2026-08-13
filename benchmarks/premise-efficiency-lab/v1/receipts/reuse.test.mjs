import assert from "node:assert/strict";
import test from "node:test";
import { runReceiptReuseBenchmark } from "./reuse.mjs";

test("receipt reuse smoke is physically measured and safety-gated", async () => {
  const result = await runReceiptReuseBenchmark();
  assert.equal(result.status, "PASS");
  assert.equal(result.claims.physicalValidatorCallsMeasured, true);
  assert.equal(result.claims.externalProviderCostMeasured, false);
  assert.equal(result.claims.commercialClaim, false);
  assert.equal(result.gates.allSemanticsEquivalent, true);
  assert.equal(result.gates.independentOracle, true);
  assert.equal(result.gates.receiptAccounting, true);
  assert.equal(result.gates.authorizationIsolation, true);
  assert.equal(result.gates.invalidationSafety, true);
  assert.equal(result.gates.failureSafety, true);
  assert.equal(result.gates.toctouSafety, true);
  assert.ok(result.rows.some(({ id, validationReductionPercent }) => id === "sequential-completed-reuse" && validationReductionPercent > 90));
  for (const row of result.rows) {
    assert.equal(row.gate, true, row.id);
    if (row.candidate.receiptLookups > 0) {
      assert.equal(
        row.candidate.receiptLookups,
        row.candidate.receiptHits + row.candidate.receiptMisses + row.candidate.staleReceiptRejections,
        `${row.id}: receipt accounting`
      );
    }
  }
});
