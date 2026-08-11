import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, makeTasks, runArm, sha } from "../mutation-campaign.mjs";
import { scientificArmOrder, scientificStrategies } from "../mutation-strategies.mjs";
import {
  idealOracleLowerBound,
  mdeForProportionDifference,
  mdeForRelativeCost,
  powerForProportionDifference,
  powerForRelativeCost,
  summarizeSafeEfficiency
} from "./metrics.mjs";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const outputRoot = resolve(root, ".tmp/scientific-mvp");
const execFileAsync = promisify(execFile);

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value === undefined ? fallback : value.slice(prefix.length);
}

function fixed(value) {
  return value === null || value === undefined || Number.isNaN(value) ? "UNKNOWN" : Number(value).toFixed(2);
}

function money(value) {
  return value === null || value === undefined || Number.isNaN(value) ? "UNKNOWN" : `$${Number(value).toFixed(8)}`;
}

function reportMarkdown(report) {
  const rows = report.results.map(({ id, metrics }) => [
    `| ${id} | ${fixed(metrics.safeCompletionRatePer100)}% | ${fixed(metrics.unsafeActionRatePer100)}% | ${fixed(metrics.falseBlockRatePer100)} | ${money(metrics.csfaUsd ?? metrics.safeCostUsd)} | ${money(metrics.costPerSafeAttemptUsd)} | ${fixed(metrics.connectorRequestsPer100)} | ${fixed(metrics.externalReadsPer100)} |`
  ].join(""));
  return [
    `# Scientific MVP — ${report.taskCount} tareas`,
    "",
    `Seed: **${report.seed}** · round: **${report.round}** · candidates: **${report.results.length}**`,
    "",
    "> This is a deterministic control campaign. It is not provider billing and does not establish an LLM claim.",
    "",
    "## Blind safety and cost table",
    "",
    "| Anonymous candidate | Safe completion / 100 | Unsafe / 100 | False block / 100 | CSFA proxy | Cost / safe attempt | Requests / 100 | Reads / 100 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    `Blind winner: **${report.winner ?? "none"}**`,
    "",
    "CSFA uses the declared deterministic payload proxy. Provider tokens and provider billing are not measured in this campaign.",
    ""
  ].join("\n");
}

function publicTasks(tasks) {
  return tasks.map(({ taskId, prompt, source }) => ({ taskId, prompt, source, tools: ["check", "read", "act", "actIfVersion"] }));
}

async function commandOutput(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { cwd: root, windowsHide: true });
    return stdout.trim() || "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

async function sourceHashes() {
  const files = [
    "benchmarks/premisebench-agent/scientific/runner.mjs",
    "benchmarks/premisebench-agent/scientific/metrics.mjs",
    "benchmarks/premisebench-agent/scientific/adversarial.mjs",
    "benchmarks/premisebench-agent/scientific/examiner.mjs",
    "benchmarks/premisebench-agent/mutation-campaign.mjs",
    "benchmarks/premisebench-agent/mutation-strategies.mjs"
  ];
  const entries = await Promise.all(files.map(async (file) => {
    return [file, sha(await readFile(resolve(root, file), "utf8"))];
  }));
  return Object.fromEntries(entries);
}

async function reproducibility() {
  const [commit, dirty, packageText, hashes] = await Promise.all([
    commandOutput("git", ["rev-parse", "HEAD"]),
    commandOutput("git", ["status", "--porcelain"]),
    readFile(resolve(root, "package.json"), "utf8"),
    sourceHashes()
  ]);
  let packageManager = "UNKNOWN";
  try {
    packageManager = JSON.parse(packageText).packageManager ?? packageManager;
  } catch {
    // Keep the manifest explicit when a partially checked-out workspace is used.
  }
  return {
    commit,
    worktreeDirty: dirty !== "UNKNOWN" && dirty.length > 0,
    node: process.version,
    packageManager,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    runnerHash: hashes["benchmarks/premisebench-agent/scientific/runner.mjs"],
    sourceHashes: hashes
  };
}

function blindMetrics(metrics) {
  const allowed = new Set([
    "tasks", "attempts", "safeAttempts", "safeSuccessfulTasks", "safeCompletionRate", "unsafeActions",
    "unsafeActionRate", "falseBlocks", "connectorRequests", "connectorRequestsPer100", "externalReads",
    "externalReadsPer100", "externalWrites", "externalWritesPer100", "costPerSafeAttemptUsd",
    "costPerSafeSuccessfulTaskUsd", "csfaUsd",
    "wastedWork", "wastedWorkCostUsd", "costCoverage", "costBasis"
  ]);
  const result = Object.fromEntries(Object.entries(metrics).filter(([key]) => allowed.has(key)));
  result.safeCompletionRate = metrics.safeCompletionRateFraction;
  result.unsafeActionRate = metrics.unsafeActionRateFraction;
  result.costProxyUsd = metrics.agentVisibleCostProxy;
  result.costProxyUsdPer100 = metrics.agentVisibleCostProxyPer100;
  return result;
}

function plannedPower(taskCount) {
  return {
    safeCompletion: {
      power: powerForProportionDifference({ baselineRate: 0.90, treatmentRate: 0.98, nPerArm: taskCount, alpha: 0.05 }),
      mde: mdeForProportionDifference({ baselineRate: 0.90, nPerArm: taskCount, alpha: 0.05, power: 0.80 })
    },
    unsafeAction: {
      power: powerForProportionDifference({ baselineRate: 0.03, treatmentRate: 0.01, nPerArm: taskCount, alpha: 0.05 }),
      mde: mdeForProportionDifference({ baselineRate: 0.03, nPerArm: taskCount, alpha: 0.05, power: 0.80, direction: -1 })
    },
    csfa: {
      power: powerForRelativeCost({ relativeEffect: -0.20, coefficientOfVariation: 1, nPerArm: taskCount, alpha: 0.05 }),
      mde: mdeForRelativeCost({ coefficientOfVariation: 1, nPerArm: taskCount, alpha: 0.05, power: 0.80 })
    }
  };
}

async function main() {
  const tasksCount = Number(arg("tasks", "200"));
  const seed = Number(arg("seed", "20260811"));
  const round = arg("round", "scientific-mvp-dev");
  const holdout = arg("holdout", "false").toLowerCase() === "true";
  const seedWasExplicit = process.argv.some((value) => value.startsWith("--seed="));
  if (!Number.isSafeInteger(tasksCount) || tasksCount < 20 || tasksCount > 10_000) throw new Error("--tasks must be an integer from 20 to 10000");
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be an integer");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(round)) throw new Error("--round must be a safe directory name");
  if (holdout && !round.toLowerCase().includes("holdout")) throw new Error("a holdout run must use a round name containing holdout");
  if (holdout && !seedWasExplicit) throw new Error("a holdout run must supply --seed explicitly");

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const tasks = makeTasks(tasksCount, seed);
  const directory = resolve(outputRoot, round);
  await mkdir(directory, { recursive: true });
  const reproducibilityInfo = await reproducibility();
  const power = plannedPower(tasks.length);
  const plan = {
    format: "premisebench-agent/scientific-mvp-plan/v1",
    round,
    seed,
    holdout,
    datasetRole: holdout ? "sealed-holdout" : "development-control",
    taskCount: tasks.length,
    taskSetHash: sha(publicTasks(tasks)),
    policies: scientificArmOrder,
    power,
    reproducibility: reproducibilityInfo,
    status: "FROZEN_BEFORE_EXECUTION",
    createdAt: startedAt
  };
  await writeFile(resolve(directory, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  const candidates = [];
  for (const arm of scientificArmOrder) {
    const traces = [];
    for (const task of tasks) traces.push(await runArm(arm, task, scientificStrategies));
    const id = sha(`${round}:${seed}:${arm}`).slice(7, 19);
    const base = aggregate(arm, traces, scientificStrategies);
    const efficiency = summarizeSafeEfficiency(traces, {
      proxyField: "agentVisibleCostProxy",
      proxyDeclared: true,
      costMode: "synthetic-proxy",
      tasks
    });
    candidates.push({ id, arm, traces, metrics: { ...base, ...efficiency } });
  }

  const blindInput = {
    format: "premisebench-agent/scientific-mvp/v1",
    taskCount: tasks.length,
    taskSetHash: sha(publicTasks(tasks)),
    results: candidates.map(({ id, metrics }) => ({ id, metrics: blindMetrics(metrics) }))
  };
  const blindPath = resolve(directory, "blind-report.json");
  const examinedPath = resolve(directory, "examined-report.json");
  await writeFile(blindPath, `${JSON.stringify(blindInput, null, 2)}\n`, "utf8");
  await execFileAsync(process.execPath, [
    resolve(root, "benchmarks/premisebench-agent/scientific/examiner.mjs"),
    `--input=${blindPath}`,
    `--output=${examinedPath}`
  ], { cwd: root, windowsHide: true });
  const examined = JSON.parse(await readFile(examinedPath, "utf8"));
  const report = {
    format: "premisebench-agent/scientific-mvp/v1",
    status: holdout ? "deterministic-holdout" : "deterministic-control",
    round,
    seed,
    holdout,
    taskCount: tasks.length,
    taskSetHash: sha(publicTasks(tasks)),
    oracle: { exposedToAgent: false, evaluatorOnly: true },
    labels: "withheld",
    results: examined.results,
    winner: examined.winner,
    blindExaminer: examined,
    power,
    idealOracle: idealOracleLowerBound(tasks, { proxyField: "agentVisibleCostProxy", proxyDeclared: true }),
    reproducibility: reproducibilityInfo,
    caveats: [
      "Candidate IDs are blind in blind-report.json; mapping.private.json is evaluator-only.",
      "Synthetic payload proxy is not provider billing.",
      holdout
        ? "The holdout seed was supplied privately for this single release-candidate run; this deterministic holdout is not an independent external audit."
        : "This campaign does not run a language model or prove a production claim."
    ]
  };
  for (const candidate of candidates) await writeFile(resolve(directory, `candidate-${candidate.id}.json`), `${JSON.stringify({ id: candidate.id, taskSetHash: report.taskSetHash, traces: candidate.traces }, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "mapping.private.json"), `${JSON.stringify(Object.fromEntries(candidates.map(({ id, arm }) => [id, arm])), null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "summary.json"), `${JSON.stringify({ ...report, results: candidates.map(({ id, arm, metrics }) => ({ id, arm, name: scientificStrategies[arm].name, metrics })) }, null, 2)}\n`, "utf8");
  const manifest = {
    format: report.format,
    benchmark: "PremiseBench-Agent",
    benchmarkVersion: "scientific-mvp/1",
    campaign: { provider: "deterministic-control", world: "filesystem", holdout, tasks: tasks.length, seed, round },
    taskSetHash: report.taskSetHash,
    policies: scientificArmOrder,
    planHash: sha(plan),
    oracle: report.oracle,
    providerCost: "NOT_MEASURED",
    startedAt,
    durationMs: Number((performance.now() - started).toFixed(3)),
    generatedAt: new Date().toISOString(),
    reproducibility: report.reproducibility
  };
  await writeFile(resolve(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "dataset-manifest.json"), `${JSON.stringify({ format: "premisebench-agent/scientific-dataset/v1", role: holdout ? "sealed-holdout-after-run" : "development", taskSetHash: report.taskSetHash, tasks: publicTasks(tasks), labels: "withheld", agentInputExcludes: ["mutation", "objective", "expected", "outcome", "oracle", "groundTruth", "labels"] }, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "power.json"), `${JSON.stringify(report.power, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "ideal-oracle.json"), `${JSON.stringify(report.idealOracle, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "tables.md"), `${reportMarkdown(report)}\n`, "utf8");
  await writeFile(resolve(directory, "report.md"), `${reportMarkdown(report)}\n`, "utf8");
  console.log(JSON.stringify({ round, tasks: tasks.length, winner: report.winner, results: report.results.map(({ id, metrics, eligible }) => ({ id, eligible, safeCompletionRate: metrics.safeCompletionRatePer100, unsafeActionRate: metrics.unsafeActionRatePer100, csfa: metrics.csfaUsd, requestsPer100: metrics.connectorRequestsPer100, readsPer100: metrics.externalReadsPer100 })) }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

export { main };
