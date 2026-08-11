import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapPairedDelta, groupByStrata, paretoFrontier, publicFrontierReport } from "./frontier.mjs";

const candidates = [
  { id: "cheap", metrics: { safeCompletionRatePer100: 90, csfaUsd: 1 } },
  { id: "balanced", metrics: { safeCompletionRatePer100: 98, csfaUsd: 2 } },
  { id: "dominated", metrics: { safeCompletionRatePer100: 95, csfaUsd: 3 } },
  { id: "unknown", metrics: { safeCompletionRatePer100: 99, csfaUsd: "UNKNOWN" } }
];

test("Pareto frontier keeps measured non-dominated points and excludes unknown cost", () => {
  assert.deepEqual(paretoFrontier(candidates).map(({ id }) => id), ["cheap", "balanced"]);
  const report = publicFrontierReport(candidates);
  assert.deepEqual(report.unknownCostCandidates, ["unknown"]);
});

test("strata aggregation preserves missing cost as UNKNOWN", () => {
  const rows = groupByStrata([
    { domain: "fs", volatility: 5, risk: "low", metrics: { safeCompletionRatePer100: 100, unsafeActionRatePer100: 0, csfaUsd: 1 } },
    { domain: "fs", volatility: 5, risk: "low", metrics: { safeCompletionRatePer100: 90, unsafeActionRatePer100: 10, csfaUsd: "UNKNOWN" } }
  ], ["domain", "volatility", "risk"]);
  assert.equal(rows[0].safeCompletionPer100, 95);
  assert.equal(rows[0].costStatus, "UNKNOWN");
  assert.equal(rows[0].csfa, 1);
});

test("paired bootstrap is deterministic and reports unknown inputs", () => {
  const first = bootstrapPairedDelta([1, 2, 3], [0, 1, 2], { seed: 7, iterations: 100 });
  const second = bootstrapPairedDelta([1, 2, 3], [0, 1, 2], { seed: 7, iterations: 100 });
  assert.deepEqual(first, second);
  assert.equal(first.estimate, 1);
  assert.equal(bootstrapPairedDelta([1], ["UNKNOWN"]).status, "UNKNOWN");
});
