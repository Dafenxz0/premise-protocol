import { readFile } from "node:fs/promises";
import {
  assertExternalEvidence,
  loadManifests,
  outputPaths,
  percentile,
  publicTask
} from "./lib/core.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(`[ga-evaluation self-check] ${message}`);
}

const requireOutput = process.argv.includes("--require-output");
const requireExternal = process.argv.includes("--require-external");

async function readIfPresent(url) {
  try {
    return await readFile(url, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

const { campaign, datasets, prompts, labels, tasks } = await loadManifests();
assert(campaign.evidencePolicy.executionClass === "local-runner", "campaign is not classified as local execution");
assert(prompts.format === "ga-evaluation-prompt-manifest/1", "prompt manifest is not separated");
assert(labels.format === "ga-evaluation-label-manifest/1", "label manifest is not separated");
assert(!JSON.stringify(prompts).includes('"oracle"'), "prompt manifest contains an oracle");
assert(!JSON.stringify(prompts).includes('"snapshot"'), "prompt manifest contains a snapshot");
assert(labels.labels.size === prompts.tasks.length, "label manifest is not one-to-one with prompts");
assert(tasks.splitCounts.visible >= 8, "visible split is too small");
assert(tasks.splitCounts.hidden >= 6, "hidden split is too small");
assert(tasks.splitCounts.holdout >= 6, "holdout split is too small");
assert(percentile([1, 2, 3, 4], 0.99) === 4, "p99 percentile is not nearest-rank deterministic");
let fixtureRejected = false;
try {
  assertExternalEvidence({ kind: "external", origin: "public-download", datasetId: "fixture-source", sourceUri: "fixture://not-external", downloadUrl: "https://raw.githubusercontent.com/octocat/Hello-World/7fd1a60b01f91b314f59955a4e4d4e80d8edf11d/README", sha256: "03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340" });
} catch {
  fixtureRejected = true;
}
assert(fixtureRejected, "fixture evidence was not rejected");

for (const task of tasks.tasks) {
  const sanitized = publicTask(task, datasets);
  const serialized = JSON.stringify(sanitized);
  for (const forbidden of ["oracle", "snapshot", "expected", "gold", "answer"]) assert(!serialized.includes(`\"${forbidden}\"`), `candidate task leaks ${forbidden}`);
  assert(!serialized.includes("fixture://"), `candidate task leaks fixture evidence for ${task.id}`);
  assert(sanitized.source.id !== task.sourceId, `candidate task exposes internal source id for ${task.id}`);
}

const paths = outputPaths();
const [resultText, reportText, tracesText] = await Promise.all([
  readIfPresent(paths.result),
  readIfPresent(paths.report),
  readIfPresent(paths.traces)
]);
let outputsPresent = false;
if (resultText !== undefined || reportText !== undefined || tracesText !== undefined) {
  outputsPresent = true;
  assert(resultText !== undefined && reportText !== undefined && tracesText !== undefined, "JSON, Markdown, and trace outputs must be emitted together");
  const result = JSON.parse(resultText);
  assert(result.format === "ga-evaluation-result/2", "unexpected result format");
  assert(result.benchmark.promptManifestVersion === prompts.version, "result does not bind the prompt manifest");
  assert(result.benchmark.labelManifestVersion === labels.version, "result does not bind the label manifest");
  assert(result.benchmark.baselineStrategy === "retrieval-no-protocol", "result does not name the no-protocol baseline");
  assert(result.evidence.source.class === "external-public-static", "source evidence is not classified as external static");
  assert(result.evidence.source.hashesVerified === true, "source hashes are not marked verified");
  assert(result.evidence.execution.class === "local-runner", "execution evidence is not classified as local");
  assert(result.evidence.execution.independent === false, "local execution is incorrectly marked independent");
  assert(result.evidence.syntheticData.accepted === false && result.evidence.syntheticData.detectedMarkers === 0, "synthetic data policy was not fail-closed");
  assert(result.evidence.eligibleForPublicClaim === false, "local result is incorrectly eligible for a public claim");
  assert(result.verification.externalOnly === true, "result is not marked external-only");
  assert(result.verification.fixtureEvidenceAccepted === false, "result accepted fixture evidence");
  assert(result.verification.datasetsVerified === datasets.datasets.length, "not every public dataset was verified");
  assert(result.traceCount === tracesText.trim().split(/\r?\n/u).length, "trace count does not match JSONL output");
  for (const metric of result.metrics) {
    for (const field of ["correctRate", "freshnessRate", "falsePositiveRate", "availabilityRate", "errorRate", "requests", "costUsd", "costPer1000TasksUsd", "latencyMs"]) assert(Object.hasOwn(metric, field), `${metric.strategy} is missing ${field}`);
    for (const percentileName of ["p50", "p95", "p99"]) assert(Number.isFinite(metric.latencyMs[percentileName]), `${metric.strategy} is missing latency ${percentileName}`);
  }
  const premise = result.metrics.find((metric) => metric.strategy === "PREMiSE");
  const baseline = result.metrics.find((metric) => metric.strategy === "retrieval-no-protocol");
  assert(baseline?.baseline === true && baseline?.protocol === "none", "no-protocol baseline is not explicitly marked");
  assert(premise?.correctRate === 1, "PREMiSE reference strategy is not exact on the verified task parser");
  assert(premise?.freshnessRate === 1, "PREMiSE reference strategy served stale evidence");
  assert(premise?.falsePositiveRate === 0, "PREMiSE reference strategy produced a false positive");
  for (const line of tracesText.trim().split(/\r?\n/u)) {
    const trace = JSON.parse(line);
    for (const forbidden of ["answer", "expected", "oracle", "snapshot", "gold"]) assert(!Object.hasOwn(trace, forbidden), `trace leaks ${forbidden}`);
    assert(trace.evidenceOrigin === undefined || trace.evidenceOrigin === "public-download", "trace records non-public evidence");
  }
  assert(reportText.includes("p50 / p95 / p99"), "Markdown report omits latency percentiles");
  assert(reportText.includes("Allowed claims"), "Markdown report omits claims boundary");
  assert(reportText.includes("Source evidence"), "Markdown report omits source evidence class");
  assert(reportText.includes("Execution evidence"), "Markdown report omits local execution class");
  assert(reportText.includes("baseline without protocol"), "Markdown report omits the no-protocol baseline");
  assert(reportText.includes("Cost proxy / 1,000 tasks"), "Markdown report omits bounded cost semantics");
}

if (requireOutput) assert(outputsPresent, "a runnable evidence output is required by this gate");
if (requireExternal) {
  assert(outputsPresent, "external evidence gate requires a completed run");
  assert(JSON.parse(resultText).verification.datasetsVerified === datasets.datasets.length, "external evidence gate requires every pinned dataset");
}

console.log(JSON.stringify({ status: "PASS", datasets: datasets.datasets.length, splits: tasks.splitCounts, fixtureEvidenceRejected: fixtureRejected, outputsPresent, requiredOutput: requireOutput, requiredExternal: requireExternal }));
