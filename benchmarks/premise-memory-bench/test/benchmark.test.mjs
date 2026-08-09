import assert from "node:assert/strict";
import { baselines, createFilesystemWorld, evaluate, report, runEpisode } from "../dist/index.js";

const definition = { id: "smoke", sourceUri: "filesystem://resource", reopenBeforeRecall: true, actionRequired: true };
const trace = await runEpisode(definition, createFilesystemWorld(definition.sourceUri));
assert.equal(trace.staleRecall, true);
assert.equal(trace.staleAction, true);
const results = Object.values(baselines).map((baseline) => baseline({ stale: trace.staleRecall, protocolDecision: "REVALIDATE", refresh: () => true }));
const output = report(results.map((result) => evaluate(result.name, [trace], [result])));
assert.equal(output.format, "premise-benchmark-results/0.1");
assert.equal(output.results.length, 5);
console.log("benchmark tests passed");
