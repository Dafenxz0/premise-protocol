import assert from "node:assert/strict";
import test from "node:test";
import { runReceiptReuseBenchmark } from "./reuse.mjs";

for (const profile of ["smoke", "medium"]) {
  test(`receipt reuse ${profile} is physically measured and safety-gated`, async () => {
    const result = await runReceiptReuseBenchmark({ profile });
    assert.equal(result.status, result.eligibility === "PASS" ? "PASS" : "INCONCLUSIVE");
    assert.equal(result.claims.physicalValidatorCallsMeasured, true);
    assert.equal(result.claims.independentOracleProcess, true);
    assert.equal(result.claims.semanticEquivalenceFullTrace, true);
    assert.equal(result.claims.externalProviderCostMeasured, false);
    assert.equal(result.claims.commercialClaim, false);
    assert.equal(result.gates.allSemanticsEquivalent, true);
    assert.equal(result.gates.independentOracle, true);
    assert.equal(result.gates.receiptAccounting, true);
    assert.equal(result.gates.authorizationIsolation, true);
    assert.equal(result.gates.scopeMatrixIsolation, true);
    assert.equal(result.gates.tenantIsolation, true);
    assert.equal(result.gates.incompleteScopeSafety, true);
    assert.equal(result.gates.invalidationSafety, true);
    assert.equal(result.gates.failureSafety, true);
    assert.equal(result.gates.inFlightInvalidationSafety, true);
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
}
