import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baselines, baselineOrder } from "./baselines.mjs";
import { bootstrapPairedDelta, summarize } from "./statistics.mjs";
import { renderTables } from "./tables.mjs";
import { makeTasks } from "./scenarios/tasks.mjs";
import { createFilesystemWorld } from "./worlds/filesystem.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const artifactDir = resolve(root, "benchmarks/premisebench-agent/artifacts");

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.find((value) => value.startsWith(prefix));
  return item === undefined ? fallback : item.slice(prefix.length);
}

function noOracle(value) {
  const forbidden = /oracle|groundTruth|expected|mutation|outcome/i;
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.test(key)) throw new Error(`Oracle-like field leaked into agent input: ${key}`);
      noOracle(child);
    }
  }
}

async function runOne(policyId, task) {
  const policy = baselines[policyId];
  const world = await createFilesystemWorld(task);
  const started = performance.now();
  let reads = 0;
  let actions = 0;
  let changeDetected = false;
  let writeMutationTriggered = false;
  const initial = await world.read();
  reads += 1;
  const agentInput = {
    taskId: task.taskId,
    source: task.source,
    memory: initial,
    cacheAge: task.cacheAge
  };
  noOracle(agentInput);
  if (task.mutationWindow === "before-action") await world.mutateExternally();
  const api = {
    task: { taskId: task.taskId, cacheAge: task.cacheAge },
    memory: initial,
    ttl: 5,
    read: async () => { reads += 1; const snapshot = await world.read(); if (snapshot.version !== initial.version) changeDetected = true; return snapshot; },
    act: async (action) => { actions += 1; if (task.mutationWindow === "during-write" && !writeMutationTriggered) { writeMutationTriggered = true; await world.mutateExternally(); changeDetected = true; } return world.act(action); },
    actIfVersion: async (version, action) => { actions += 1; if (task.mutationWindow === "during-write" && !writeMutationTriggered) { writeMutationTriggered = true; await world.mutateExternally(); } const response = await world.actIfVersion(version, action); if (!response.accepted) changeDetected = true; return response; },
    reject: async (action) => { actions += 1; if (task.mutationWindow === "during-write" && !writeMutationTriggered) { writeMutationTriggered = true; await world.mutateExternally(); changeDetected = true; } return world.reject(action); }
  };
  await policy.run(api);
  const evaluation = await world.evaluate();
  const latencyMs = performance.now() - started;
  const row = {
    taskId: task.taskId,
    family: task.family,
    unsafeAction: evaluation.unsafe,
    completed: evaluation.correct,
    falseBlock: evaluation.falseBlock,
    changeDetected: changeDetected || evaluation.changed && evaluation.correct,
    revalidations: Math.max(0, reads - 1),
    requests: reads + actions,
    tokens: 0,
    latencyMs,
    recovered: evaluation.recovered,
    toctouEscape: evaluation.toctouEscape,
    agentInput,
    events: { reads, actions, mutationCount: evaluation.mutationCount }
  };
  await world.cleanup();
  return row;
}

async function main() {
  const tasksCount = Number(arg("tasks", "100"));
  const seed = Number(arg("seed", "20260811"));
  const selected = (arg("policies", baselineOrder.join(","))).split(",").filter(Boolean);
  if (!Number.isSafeInteger(tasksCount) || tasksCount < 1 || tasksCount > 10000) throw new Error("--tasks must be an integer from 1 to 10000");
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be an integer");
  for (const policy of selected) if (!baselines[policy]) throw new Error(`Unknown policy ${policy}`);
  const tasks = makeTasks(tasksCount, seed);
  const rows = [];
  for (const policy of selected) for (const task of tasks) rows.push({ policy, ...(await runOne(policy, task)) });
  const summaries = selected.map((policy) => summarize(rows.filter((row) => row.policy === policy), policy, { name: baselines[policy].name }));
  const byPolicy = (policy) => rows.filter((row) => row.policy === policy);
  const comparisons = selected.includes("H") && selected.includes("B") ? {
    "H-vs-B": {
      unsafeActionsPer100Delta: bootstrapPairedDelta(byPolicy("H"), byPolicy("B"), "unsafeAction"),
      tasksCompletedPer100Delta: bootstrapPairedDelta(byPolicy("H"), byPolicy("B"), "completed")
    }
  } : {};
  const runManifest = {
    benchmark: "PremiseBench-Agent",
    benchmarkVersion: "0.1.0",
    campaign: { class: "smoke-deterministic-control", world: "filesystem", provider: "deterministic-control", tasks: tasksCount, seed, holdout: false },
    policies: selected,
    oracle: { exposedToAgent: false, evaluatorOnly: true },
    generatedAt: new Date().toISOString()
  };
  await mkdir(artifactDir, { recursive: true });
  await writeFile(resolve(artifactDir, "summary.json"), `${JSON.stringify({ ...runManifest, baselines: summaries, comparisons }, null, 2)}\n`, "utf8");
  const comparisonText = comparisons["H-vs-B"] ? `\n## Paired comparison\n\nH minus B, paired by task (negative unsafe delta and positive completion delta are favorable):\n\n| Comparison | Estimate | 95% interval |\n| --- | ---: | ---: |\n| Unsafe actions / 100 | ${comparisons["H-vs-B"].unsafeActionsPer100Delta.estimate.toFixed(1)} | ${comparisons["H-vs-B"].unsafeActionsPer100Delta.lower95.toFixed(1)}–${comparisons["H-vs-B"].unsafeActionsPer100Delta.upper95.toFixed(1)} |\n| Completed / 100 | ${comparisons["H-vs-B"].tasksCompletedPer100Delta.estimate.toFixed(1)} | ${comparisons["H-vs-B"].tasksCompletedPer100Delta.lower95.toFixed(1)}–${comparisons["H-vs-B"].tasksCompletedPer100Delta.upper95.toFixed(1)} |\n` : "";
  const renderedTables = renderTables({ campaign: runManifest.campaign, baselines: summaries });
  await writeFile(resolve(artifactDir, "report.md"), `# PremiseBench-Agent smoke report\n\n${renderedTables}${comparisonText}\n## Interpretation\n\nThis run exercises a temporary filesystem with controlled external changes. It demonstrates whether the harness distinguishes stale actions, safe rejection, recovery, and compare-and-set protection. It does **not** establish model quality, provider cost, production availability, or GA readiness.\n\nLive GitHub/PostgreSQL campaigns remain opt-in and are reported as NOT_RUN unless their controlled targets and credentials are explicitly supplied.\n`, "utf8");
  await writeFile(resolve(artifactDir, "tables.md"), `${renderedTables}${comparisonText}\n`, "utf8");
  await writeFile(resolve(artifactDir, "traces.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  await writeFile(resolve(artifactDir, "manifest.json"), `${JSON.stringify(runManifest, null, 2)}\n`, "utf8");
  await writeFile(resolve(artifactDir, "dataset-manifest.json"), `${JSON.stringify({ generator: "scenarios/tasks.mjs", seed, tasks: tasksCount, families: ["stable", "repairable", "incompatible", "toctou"], agentInputExcludes: ["expected", "oracle", "groundTruth", "mutation", "outcome"] }, null, 2)}\n`, "utf8");
  console.log(`PremiseBench-Agent smoke: PASS (${tasksCount} tasks × ${selected.length} baselines)`);
  for (const summary of summaries) console.log(`${summary.policy} ${summary.name}: unsafe ${summary.unsafeActionsPer100.toFixed(1)}/100, completed ${summary.tasksCompletedPer100.toFixed(1)}/100, requests ${summary.requestsPer100.toFixed(1)}/100`);
}

await main();
