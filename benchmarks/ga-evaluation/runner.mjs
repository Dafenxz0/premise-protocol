import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildResult,
  expandTasks,
  loadManifests,
  outputPaths,
  runStrategy,
  verifyDatasets,
  writeOutputs
} from "./lib/core.mjs";

const BENCHMARK_ROOT = fileURLToPath(new URL("./", import.meta.url));

function optionValue(args, name, fallback) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export async function run(argv = process.argv.slice(2)) {
  const split = optionValue(argv, "--split", "all");
  if (!["all", "visible", "hidden", "holdout"].includes(split)) throw new Error("--split must be all, visible, hidden, or holdout");
  const repetitions = positiveInteger(optionValue(argv, "--repetitions", "1"), "--repetitions");
  const candidateCommand = optionValue(argv, "--candidate", undefined);
  const taskTimeoutMs = positiveInteger(optionValue(argv, "--task-timeout-ms", "120000"), "--task-timeout-ms");

  const { datasets, labels, tasks: taskManifest } = await loadManifests();
  const tasks = expandTasks(taskManifest, split, repetitions);
  const runId = `ga-${new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const runtimeRoot = join(BENCHMARK_ROOT, "runtime", runId);
  await mkdir(runtimeRoot, { recursive: true });

  // Verification is intentionally before any strategy starts; a mismatch is a hard failure.
  const preflight = await verifyDatasets(datasets, { runtimeRoot });
  const strategies = [];
  for (const strategy of ["direct-read", "ttl-cache", "retrieval-no-protocol", "PREMiSE"]) {
    strategies.push(await runStrategy(strategy, tasks, datasets, preflight, { ttlTurns: 3 }));
  }
  if (candidateCommand) strategies.push(await runStrategy("candidate", tasks, datasets, preflight, { candidateCommand, taskTimeoutMs }));

  const result = buildResult({
    runId,
    generatedAt: new Date().toISOString(),
    split,
    repetitions,
    tasks,
    datasets,
    taskManifest,
    labelManifest: labels,
    preflight,
    strategies,
    candidateCommand
  });
  await writeOutputs(result, strategies);
  const paths = outputPaths();
  console.log(JSON.stringify({
    status: "PASS",
    runId,
    split,
    tasks: tasks.length,
    datasetsVerified: result.verification.datasetsVerified,
    strategies: result.metrics.map(({ strategy, correctRate, freshnessRate, falsePositiveRate, availabilityRate, latencyMs, requests, costUsd }) => ({ strategy, correctRate, freshnessRate, falsePositiveRate, availabilityRate, latencyMs, requests, costUsd })),
    outputs: Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, fileURLToPath(value)]))
  }, null, 2));
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
