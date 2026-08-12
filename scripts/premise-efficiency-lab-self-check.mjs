import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runCampaign } from "../benchmarks/premise-efficiency-lab/runner.mjs";
import { createMutationEvents, normalizeMutationEvents } from "../benchmarks/premise-efficiency-lab/generators/events.mjs";
import { assertNoOracle } from "../benchmarks/premise-efficiency-lab/referee/blind-evaluator.mjs";

const first = runCampaign({ tasks: 24, seed: 20260812, volatility: 0.5, nodeCount: 24 });
const second = runCampaign({ tasks: 24, seed: 20260812, volatility: 0.5, nodeCount: 24 });
assert.deepEqual(first, second, "same seed must produce the same calibration result");
assert.equal(first.safetyGate.premiseUnsafeActions, 0);
assert.equal(first.blindEvaluation.status, "COMPLETE");
assert.equal(first.sealedManifest.status, "SEALED");
assert.equal(normalizeMutationEvents(createMutationEvents({ nodeIds: ["a", "b", "c"], schedule: "gapped" })).status, "UNKNOWN");
assert.throws(() => assertNoOracle({ observation: { expectedDecision: "ALLOW" } }), /oracle leakage/);
const source = await readFile("benchmarks/premise-efficiency-lab/runner.mjs", "utf8");
assert.match(source, /blindEvaluation/);
process.stdout.write("PREMiSE Efficiency Lab self-check PASS\n");
