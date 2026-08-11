import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { aggregate, runArm } from "../mutation-campaign.mjs";
import { scientificArmOrder, scientificStrategies } from "../mutation-strategies.mjs";
import { generateCampaigns, RISK_LEVELS, VOLATILITY_LEVELS, WORLD_KINDS } from "./campaigns.mjs";
import { publicFrontierReport } from "./frontier.mjs";
import { summarizeSafeEfficiency } from "./metrics.mjs";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const outputRoot = resolve(root, ".tmp/scientific-mvp/matrix");
const execFileAsync = promisify(execFile);
function stable(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

export function sha(value) {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : stable(value), "utf8").digest("hex")}`;
}

export function makeMatrixTasks({ tasksPerCell = 20, seed = 20260811, volatilityLevels = VOLATILITY_LEVELS, riskLevels = RISK_LEVELS, worlds = WORLD_KINDS } = {}) {
  if (!Number.isSafeInteger(tasksPerCell) || tasksPerCell < 1) throw new TypeError("tasksPerCell must be a positive safe integer");
  return generateCampaigns({ seed, taskCount: tasksPerCell, volatilities: volatilityLevels, risks: riskLevels, worlds })
    .flatMap((campaign) => campaign.scenarios.map((scenario) => ({
      taskId: scenario.taskId,
      prompt: scenario.agentInput.prompt,
      source: scenario.agentInput.source,
      family: scenario.evaluator.family,
      initial: scenario.mutation.initial,
      mutation: scenario.mutation.final,
      mutationWindow: scenario.mutation.window,
      volatility: campaign.volatility,
      risk: campaign.risk,
      domain: campaign.world
    })));
}

function blindMetrics(metrics) {
  return {
    tasks: metrics.tasks,
    safeCompletionRate: metrics.safeCompletionRateFraction,
    unsafeActionRate: metrics.unsafeActionRateFraction,
    attempts: metrics.attempts,
    safeAttempts: metrics.safeAttempts,
    safeSuccessfulTasks: metrics.safeSuccessfulTasks,
    unsafeActions: metrics.unsafeActions,
    falseBlocks: metrics.falseBlocks,
    connectorRequests: metrics.connectorRequests,
    externalReads: metrics.externalReads,
    costProxyUsd: metrics.agentVisibleCostProxy,
    costProxyUsdPer100: metrics.agentVisibleCostProxyPer100,
    costBasis: "proxy"
  };
}

function summarizeTraces(traces, arm) {
  const base = aggregate(arm, traces, scientificStrategies);
  const efficiency = summarizeSafeEfficiency(traces, {
    proxyField: "agentVisibleCostProxy",
    proxyDeclared: true,
    costMode: "synthetic-proxy"
  });
  return { ...base, ...efficiency };
}

function cellRows(traces, arm) {
  const cells = new Map();
  for (const trace of traces) {
    const key = `${trace.domain}:${trace.volatility}:${trace.risk}`;
    const list = cells.get(key) ?? [];
    list.push(trace);
    cells.set(key, list);
  }
  return [...cells.entries()].map(([key, rows]) => {
    const [domain, volatility, risk] = key.split(":");
    const metrics = summarizeTraces(rows, arm);
    return {
      arm,
      domain,
      volatility: Number(volatility),
      risk,
      tasks: metrics.tasks,
      safeCompletionPer100: metrics.safeCompletionRatePer100,
      unsafePer100: metrics.unsafeActionRatePer100,
      falseBlockPer100: metrics.falseBlockRatePer100,
      csfaProxy: metrics.csfaUsd,
      requestsPer100: metrics.connectorRequestsPer100,
      readsPer100: metrics.externalReadsPer100
    };
  });
}

function markdown({ args, results, cells, examined, frontier }) {
  const mainRows = results.map((result) => `| ${result.id} | ${result.arm} | ${result.metrics.safeCompletionRatePer100.toFixed(1)}% | ${result.metrics.unsafeActionRatePer100.toFixed(1)}% | $${result.metrics.csfaUsd.toFixed(8)} | ${result.metrics.connectorRequestsPer100.toFixed(1)} | ${result.metrics.externalReadsPer100.toFixed(1)} |`);
  const cellRowsMarkdown = cells.map((row) => `| ${row.arm} | ${row.domain} | ${row.volatility}% | ${row.risk} | ${row.safeCompletionPer100.toFixed(1)}% | ${row.unsafePer100.toFixed(1)}% | $${row.csfaProxy.toFixed(8)} | ${row.requestsPer100.toFixed(1)} | ${row.readsPer100.toFixed(1)} |`);
  return [
    `# Security-cost matrix — ${args.tasksPerCell} tasks per cell`,
    "",
    `Volatility: ${VOLATILITY_LEVELS.join("%, ")}%. Risks: ${RISK_LEVELS.join(", ")}.`,
    "",
    "> Deterministic local control. Costs are a declared agent-visible payload proxy, not provider billing; this matrix does not support an LLM or production claim.",
    "",
    "## Aggregate blind candidate table",
    "",
    "| Anonymous ID | Internal arm | Safe completion | Unsafe | CSFA proxy | Requests / 100 | Reads / 100 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...mainRows,
    "",
    `Blind examiner winner: **${examined.winner ?? "none"}**`,
    `Measured Pareto frontier: **${frontier.frontier.map(({ id }) => id).join(", ") || "none"}**`,
    "",
    "## Volatility and risk strata",
    "",
    "| Arm | Domain | Volatility | Risk | Safe completion | Unsafe | CSFA proxy | Requests / 100 | Reads / 100 |",
    "| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ...cellRowsMarkdown,
    "",
    "The risk label is a legitimate task attribute. This runner stratifies it; it does not claim that the current deterministic policies are already a complete risk-aware optimizer."
  ].join("\n");
}

export async function runMatrix({ tasksPerCell = 20, seed = 20260811, round = "matrix-dev" } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(round)) throw new TypeError("round must be a safe directory name");
  const args = { tasksPerCell, seed, round };
  const tasks = makeMatrixTasks(args);
  const tracesByArm = new Map();
  for (const arm of scientificArmOrder) {
    const traces = [];
    for (const task of tasks) {
      const trace = await runArm(arm, task, scientificStrategies);
      traces.push({ ...trace, volatility: task.volatility, risk: task.risk, domain: task.domain });
    }
    tracesByArm.set(arm, traces);
  }
  const results = scientificArmOrder.map((arm) => {
    const traces = tracesByArm.get(arm);
    return { id: sha(`${round}:${seed}:${arm}`).slice(7, 19), arm, traces, metrics: summarizeTraces(traces, arm) };
  });
  const blindInput = {
    format: "premisebench-agent/scientific-matrix-blind/v1",
    taskCount: tasks.length,
    taskSetHash: sha(tasks.map(({ taskId, prompt, source }) => ({ taskId, prompt, source }))),
    results: results.map(({ id, metrics }) => ({ id, metrics: blindMetrics(metrics) }))
  };
  const directory = resolve(outputRoot, round);
  await mkdir(directory, { recursive: true });
  const blindPath = resolve(directory, "blind-report.json");
  const examinedPath = resolve(directory, "examined-report.json");
  await writeFile(blindPath, `${JSON.stringify(blindInput, null, 2)}\n`, "utf8");
  await execFileAsync(process.execPath, [resolve(root, "benchmarks/premisebench-agent/scientific/examiner.mjs"), `--input=${blindPath}`, `--output=${examinedPath}`], { cwd: root, windowsHide: true });
  const examined = JSON.parse(await readFile(examinedPath, "utf8"));
  const cells = results.flatMap(({ arm, traces }) => cellRows(traces, arm));
  const frontier = publicFrontierReport(results);
  const report = {
    format: "premisebench-agent/scientific-matrix/v1",
    status: "deterministic-control",
    taskCount: tasks.length,
    tasksPerCell,
    seed,
    round,
    volatilityLevels: VOLATILITY_LEVELS,
    riskLevels: RISK_LEVELS,
    worlds: WORLD_KINDS,
    taskSetHash: blindInput.taskSetHash,
    results: results.map(({ id, arm, metrics }) => ({ id, arm, metrics })),
    cells,
    frontier,
    examiner: examined,
    caveats: ["Local deterministic world only.", "Synthetic payload proxy is not provider billing.", "Risk is stratified but not yet a learned optimization policy."]
  };
  await writeFile(resolve(directory, "mapping.private.json"), `${JSON.stringify(Object.fromEntries(results.map(({ id, arm }) => [id, arm])), null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "frontier.json"), `${JSON.stringify(frontier, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "dataset-manifest.json"), `${JSON.stringify({ format: "premisebench-agent/scientific-matrix-dataset/v1", taskSetHash: blindInput.taskSetHash, tasks: tasks.map(({ taskId, prompt, source }) => ({ taskId, prompt, source })), labels: "withheld", agentInputExcludes: ["mutation", "family", "risk", "volatility", "objective", "expected", "outcome", "oracle"] }, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "report.md"), `${markdown({ args, results, cells, examined, frontier })}\n`, "utf8");
  return { ...report, directory };
}

function cliValue(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tasksPerCell = Number(cliValue("tasks", "20"));
  const seed = Number(cliValue("seed", "20260811"));
  const round = cliValue("round", "matrix-dev");
  runMatrix({ tasksPerCell, seed, round }).then((result) => {
    console.log(JSON.stringify({ round: result.round, taskCount: result.taskCount, winner: result.examiner.winner, directory: result.directory }, null, 2));
  });
}
