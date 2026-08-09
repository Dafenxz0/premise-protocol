import { readFile } from "node:fs/promises";

const result = JSON.parse(await readFile(new URL("./results.json", import.meta.url), "utf8"));
const metricsByStrategy = new Map(result.pairedMetrics.map((metric) => [metric.strategy, metric]));
const baseline = metricsByStrategy.get("No protocol");
const premise = metricsByStrategy.get("PREMiSE");
const premiseEpisodes = result.perEpisode.filter((episode) => episode.strategy === "PREMiSE");

if (result.format !== "premise-real-world-benchmark/0.1") throw new Error("unexpected benchmark format");
if (result.runner !== "node24" || !result.runtime?.node?.startsWith("24.")) throw new Error(`benchmark must run on Node 24, got ${result.runtime?.node}`);
if (result.scenarioCount !== 14 || result.scenarios.length !== 14) throw new Error(`expected 14 scenarios, got ${result.scenarioCount}`);
if (!baseline || !premise) throw new Error("paired baseline and PREMiSE metrics are required");
if (result.perEpisode.length !== 28 || premiseEpisodes.length !== 14) throw new Error("every scenario must have two episodes");
if (result.determinism.networkAccess !== false || result.determinism.temporaryFixturesCleaned !== true) throw new Error("deterministic offline fixture contract failed");
if (result.integrations.validators.filesystem !== "packages/validator-filesystem/dist/index.js" || result.integrations.validators.git !== "packages/validator-git/dist/index.js") throw new Error("real validator dist integrations are missing");

if (baseline.security.unsafeActions <= 0) throw new Error("baseline must expose unsafe actions");
if (baseline.validatorCalls.validate !== 0) throw new Error("baseline must not call validators");
if (baseline.history.preservationRate !== 0) throw new Error("baseline must not fabricate protocol history");
if (premise.security.unsafeActions !== 0) throw new Error("PREMiSE performed an unsafe action");
if (premise.security.falseRejections !== 0) throw new Error("PREMiSE falsely rejected a safe target");
if (premise.security.correctDecisionRate !== 1) throw new Error("PREMiSE decisions do not match the scenario oracle");
if (premise.recovery.validatedRecoveryRate !== 1) throw new Error("safe changed-source recovery was not validated");
if (premise.validation.resultMatchRate !== 1 || premise.validation.protocolValidateCalls !== 12) throw new Error("real validator validation results/call count failed");
if (premise.history.preservationRate !== 1) throw new Error("PREMiSE history was not preserved");
if (premise.isolation.passRate !== 1) throw new Error("unrelated source change escaped its graph boundary");
if (premise.validatorCalls.byValidator.filesystem.validate !== 6 || premise.validatorCalls.byValidator.git.validate !== 6) throw new Error("filesystem/git validator call counts are not paired");
if (premise.latencyMs.p95 < premise.latencyMs.p50 || baseline.latencyMs.p95 < baseline.latencyMs.p50) throw new Error("invalid latency percentiles");

for (const episode of premiseEpisodes) {
  if (episode.decision !== episode.expectedDecision || episode.targetStatus !== episode.expectedTargetStatus) throw new Error(`decision mismatch in ${episode.scenarioId}`);
  if (episode.unsafeAction || episode.falseRejection || !episode.history.preserved || !episode.isolation.passed) throw new Error(`safety/history/isolation failure in ${episode.scenarioId}`);
  if (episode.revalidation.requested) {
    if (episode.revalidation.result !== episode.revalidation.expectedResult || episode.revalidation.calls !== 1) throw new Error(`validation mismatch in ${episode.scenarioId}`);
  } else if (episode.revalidation.calls !== 0) {
    throw new Error(`unexpected validator call in ${episode.scenarioId}`);
  }
}

for (const episode of premiseEpisodes.filter((entry) => entry.category === "false-SourceChanged")) {
  if (episode.sourceVersions.initial.token !== episode.sourceVersions.event.token || episode.revalidation.result !== "UNCHANGED") throw new Error(`false SourceChanged was not recovered in ${episode.scenarioId}`);
}

console.log(JSON.stringify({
  status: "PASS",
  node: result.runtime.node,
  scenarios: result.scenarioCount,
  baselineUnsafeActionRate: baseline.security.unsafeActionRate,
  premiseUnsafeActionRate: premise.security.unsafeActionRate,
  premiseFalseRejectionRate: premise.security.falseRejectionRate,
  premiseValidatedRecoveryRate: premise.recovery.validatedRecoveryRate,
  premiseValidatorCalls: premise.validatorCalls,
  premiseLatencyMs: premise.latencyMs,
  premiseHistoryPreservationRate: premise.history.preservationRate,
  premiseIsolationRate: premise.isolation.passRate
}, null, 2));
