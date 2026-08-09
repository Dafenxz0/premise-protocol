import { readFile } from "node:fs/promises";

const result = JSON.parse(await readFile(new URL("./results.json", import.meta.url), "utf8"));
const strategies = new Map(result.pairedMetrics.map((metric) => [metric.strategy, metric]));
const baseline = strategies.get("No protocol");
const premise = strategies.get("PREMiSE");
if (result.format !== "premise-comparative-benchmark/0.1") throw new Error("unexpected benchmark format");
if (result.scenarios.length !== 24) throw new Error(`expected 24 scenarios, got ${result.scenarios.length}`);
if (!baseline || !premise) throw new Error("both paired strategies are required");
if (premise.unsafeActionRate !== 0) throw new Error("PREMiSE has an unsafe action");
if (premise.recoveryRate !== 1) throw new Error(`repairable recovery must be 100%, got ${premise.recoveryRate}`);
if (premise.nonRepairableRejectRate !== 1) throw new Error("non-repairable cases must be rejected");
if (premise.revalidationCalls !== 21) throw new Error(`expected 21 real revalidations, got ${premise.revalidationCalls}`);
if (premise.historyPreservationRate !== 1) throw new Error("PREMiSE history was not preserved");
if (baseline.unsafeActionRate <= 0) throw new Error("baseline must expose unsafe actions");
for (const episode of result.perEpisode.filter((entry) => entry.strategy === "PREMiSE")) {
  if (episode.repaired && episode.revalidationCalls === 0) throw new Error(`false repair in ${episode.scenarioId}`);
  if (!episode.safe) throw new Error(`unsafe PREMiSE episode ${episode.scenarioId}`);
}
console.log(JSON.stringify({ status: "PASS", scenarios: result.scenarios.length, baselineUnsafeActionRate: baseline.unsafeActionRate, premiseRecoveryRate: premise.recoveryRate, premiseRevalidationCalls: premise.revalidationCalls }));
