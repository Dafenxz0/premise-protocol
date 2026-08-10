import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  detectSyntheticMarkers,
  loadManifests,
  publicTask,
  summarizeMetrics,
  validateDatasetManifest,
  validatePromptManifest
} from "../../benchmarks/ga-evaluation/lib/core.mjs";

test("blind GA inputs keep prompts, labels and pinned datasets separate", async () => {
  const { datasets, prompts, labels, tasks } = await loadManifests();
  const promptText = await readFile(new URL("../../benchmarks/ga-evaluation/prompts/v1.json", import.meta.url), "utf8");
  assert.doesNotMatch(promptText, /"(?:oracle|snapshot|answer|expected|gold)"/u);
  assert.equal(labels.labels.size, prompts.tasks.length);
  assert.equal(datasets.datasets.every((dataset) => dataset.evidenceClass === "external-public-static" && dataset.syntheticData === false), true);

  const candidateTask = publicTask(tasks.tasks[0], datasets);
  assert.notEqual(candidateTask.source.id, tasks.tasks[0].sourceId);
  assert.doesNotMatch(JSON.stringify(candidateTask), /"(?:oracle|snapshot|answer|expected|gold)"/u);
});

test("synthetic markers and synthetic dataset claims fail closed", async () => {
  const { datasets, prompts } = await loadManifests();
  assert.equal(detectSyntheticMarkers({ source: "synthetic://generated" }).length, 1);
  assert.throws(
    () => validateDatasetManifest({ ...datasets, datasets: [{ ...datasets.datasets[0], syntheticData: true }] }),
    /syntheticData must be false/u
  );
  assert.throws(
    () => validatePromptManifest({ ...prompts, tasks: [{ ...prompts.tasks[0], oracle: { kind: "contains", needle: "leak" } }] }, datasets),
    /answer-key field oracle/u
  );
});

test("no-protocol baseline exposes intuitive rates, errors and bounded cost", () => {
  const metric = summarizeMetrics("retrieval-no-protocol", [
    { available: true, correct: true, fresh: true, falsePositive: false, latencyMs: 10 },
    { available: false, correct: false, fresh: false, falsePositive: false, latencyMs: 20, error: "timeout" }
  ], {
    requests: 1,
    readRequests: 1,
    versionRequests: 0,
    byAdapter: { github: 1, filesystem: 0, git: 0 },
    operations: [{ adapter: "github" }]
  });

  assert.equal(metric.baseline, true);
  assert.equal(metric.protocol, "none");
  assert.equal(metric.correctPer100, 50);
  assert.equal(metric.errorRate, 0.5);
  assert.equal(metric.availabilityPer100, 50);
  assert.equal(metric.costPer1000TasksUsd > 0, true);
});

console.log(JSON.stringify({ status: "PASS", testType: "ga-evaluation-contract", networkCalls: 0, externalEvidenceProduced: false }));
