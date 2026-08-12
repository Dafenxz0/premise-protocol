import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HARD_RISK_LEVELS } from "./hard-scenarios.mjs";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const outputRoot = resolve(root, ".tmp/scientific-mvp/hard-ten-rounds");
const execFileAsync = promisify(execFile);
const hardCampaignScript = resolve(root, "benchmarks/premisebench-agent/scientific/hard-campaign.mjs");
const llmCampaignScript = resolve(root, "benchmarks/premisebench-agent/llm/campaign.mjs");
const roundPlan = Object.freeze([
  { number: 1, tasks: 200, volatility: 25, riskLevels: HARD_RISK_LEVELS },
  { number: 2, tasks: 200, volatility: 50, riskLevels: HARD_RISK_LEVELS },
  { number: 3, tasks: 225, volatility: 50, riskLevels: HARD_RISK_LEVELS },
  { number: 4, tasks: 225, volatility: 75, riskLevels: HARD_RISK_LEVELS },
  { number: 5, tasks: 250, volatility: 75, riskLevels: HARD_RISK_LEVELS },
  { number: 6, tasks: 250, volatility: 90, riskLevels: HARD_RISK_LEVELS },
  { number: 7, tasks: 275, volatility: 90, riskLevels: HARD_RISK_LEVELS },
  { number: 8, tasks: 275, volatility: 100, riskLevels: ["medium", "high", "critical"] },
  { number: 9, tasks: 300, volatility: 100, riskLevels: HARD_RISK_LEVELS },
  { number: 10, tasks: 300, volatility: 100, riskLevels: ["high", "critical"] },
  { number: 11, tasks: 325, volatility: 100, riskLevels: ["high", "critical"] },
  { number: 12, tasks: 325, volatility: 100, riskLevels: ["high", "critical"] },
  { number: 13, tasks: 350, volatility: 100, riskLevels: ["high", "critical"] },
  { number: 14, tasks: 350, volatility: 100, riskLevels: ["high", "critical"] },
  { number: 15, tasks: 375, volatility: 100, riskLevels: ["high", "critical"] },
  { number: 16, tasks: 375, volatility: 100, riskLevels: ["high", "critical"] },
  { number: 17, tasks: 400, volatility: 100, riskLevels: ["high", "critical"] },
  { number: 18, tasks: 400, volatility: 100, riskLevels: ["high", "critical"] },
  { number: 19, tasks: 425, volatility: 100, riskLevels: ["high", "critical"] },
  { number: 20, tasks: 425, volatility: 100, riskLevels: ["high", "critical"] }
]);

function value(argv, name, fallback) {
  const prefix = `--${name}=`;
  const item = argv.find((entry) => entry.startsWith(prefix));
  return item === undefined ? fallback : item.slice(prefix.length);
}

function integer(valueToParse, name, min, max) {
  const parsed = Number(valueToParse);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new TypeError(`--${name} must be an integer in [${min}, ${max}]`);
  return parsed;
}

function flag(argv, name) {
  return argv.includes(`--${name}`) || ["1", "true", "yes"].includes(String(value(argv, name, "")).toLowerCase());
}

function parseRiskLevels(raw) {
  const levels = [...new Set(String(raw).split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
  if (levels.length === 0 || levels.some((level) => !HARD_RISK_LEVELS.includes(level))) throw new TypeError(`risk levels must use ${HARD_RISK_LEVELS.join(", ")}`);
  return levels;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const start = integer(value(argv, "start", "1"), "start", 1, roundPlan.length);
  const end = integer(value(argv, "end", String(roundPlan.length)), "end", start, roundPlan.length);
  const llmTasks = integer(value(argv, "llm-tasks", "2"), "llm-tasks", 0, 300);
  const seed = integer(value(argv, "seed", "20260811"), "seed", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const provider = String(value(argv, "provider", "gemini")).trim().toLowerCase();
  const model = String(value(argv, "model", "gemini-3.5-flash-lite")).trim();
  const maxTokens = integer(value(argv, "max-tokens", "256"), "max-tokens", 1, 32_768);
  const delayMs = integer(value(argv, "delay-ms", "1000"), "delay-ms", 0, 60_000);
  const responseFormat = String(value(argv, "response-format", "json-object")).trim().toLowerCase();
  if (!["json-object", "none"].includes(responseFormat)) throw new TypeError("--response-format must be json-object or none");
  const endpointValue = String(value(argv, "endpoint", "")).trim();
  const credentialEnvValue = String(value(argv, "credential-env", "")).trim();
  const output = resolve(root, String(value(argv, "output", ".tmp/scientific-mvp/hard-ten-rounds")).trim());
  return Object.freeze({
    start,
    end,
    llmTasks,
    seed,
    provider,
    model,
    maxTokens,
    delayMs,
    responseFormat,
    endpoint: endpointValue || null,
    credentialEnv: credentialEnvValue || null,
    output,
    skipLlm: flag(argv, "skip-llm"),
    requireLive: flag(argv, "require-live")
  });
}

function childEnvironment(args) {
  const names = ["PATH", "Path", "SystemRoot", "TEMP", "TMP"];
  const env = Object.fromEntries(names.filter((name) => typeof process.env[name] === "string").map((name) => [name, process.env[name]]));
  const credentialArg = args.find((argument) => argument.startsWith("--credential-env="));
  if (credentialArg) {
    const name = credentialArg.slice("--credential-env=".length);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof process.env[name] === "string" && process.env[name] !== "") env[name] = process.env[name];
  } else {
    const providerArg = args.find((argument) => argument.startsWith("--provider="));
    const provider = providerArg?.slice("--provider=".length).toLowerCase();
    const defaultCredential = {
      openrouter: "OPENROUTER_API_KEY",
      gemini: "GEMINI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      "openai-compatible": "OPENAI_API_KEY"
    }[provider];
    if (defaultCredential && typeof process.env[defaultCredential] === "string" && process.env[defaultCredential] !== "") {
      env[defaultCredential] = process.env[defaultCredential];
    }
  }
  return env;
}

async function runNode(args, timeoutMs = 1_200_000) {
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: root,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: childEnvironment(args)
    });
    let parsed = null;
    try { parsed = JSON.parse(result.stdout.trim()); } catch { /* preserve raw output without pretending it is a result */ }
    return { status: "OK", result: parsed };
  } catch (error) {
    let parsed = null;
    try { parsed = JSON.parse(String(error.stdout ?? "").trim()); } catch { /* no structured result */ }
    return {
      status: "ERROR",
      result: parsed,
      code: Number.isInteger(error.code) ? error.code : null,
      timedOut: error.killed === true
    };
  }
}

function roundName(number) {
  return `r${String(number).padStart(2, "0")}`;
}

function improvementDecision(summary, previous) {
  const rows = Array.isArray(summary?.results) ? summary.results : [];
  const premise = rows.find((row) => row.arm === "premise");
  const always = rows.find((row) => row.arm === "always");
  const smart = rows.find((row) => row.arm === "smart");
  const issues = [];
  const evidence = {};
  if (!premise) issues.push("PREMiSE result missing");
  if (premise?.metrics?.unsafeActionsPer100 > 0) issues.push("PREMiSE unsafe actions detected");
  if (premise?.metrics?.tasksCompletedPer100 < 100) issues.push("PREMiSE did not complete every safe task");
  if (premise && always && premise.metrics.connectorRequestsPer100 > always.metrics.connectorRequestsPer100) issues.push("PREMiSE requests exceed Always Revalidate");
  if (premise && smart && premise.metrics.externalReadsPer100 > smart.metrics.externalReadsPer100) issues.push("PREMiSE reads exceed Smart Revalidate");
  if (premise) {
    evidence.premise = {
      safeCompletionPer100: premise.metrics.tasksCompletedPer100,
      unsafePer100: premise.metrics.unsafeActionsPer100,
      requestsPer100: premise.metrics.connectorRequestsPer100,
      readsPer100: premise.metrics.externalReadsPer100,
      writesPer100: premise.metrics.externalWritesPer100,
      visibleTokensPerTask: premise.metrics.agentVisibleTokenProxyPerTask
    };
  }
  if (always) evidence.always = { requestsPer100: always.metrics.connectorRequestsPer100, readsPer100: always.metrics.externalReadsPer100 };
  if (smart) evidence.smart = { requestsPer100: smart.metrics.connectorRequestsPer100, readsPer100: smart.metrics.externalReadsPer100 };
  return {
    status: issues.length === 0 ? "NO_UNSAFE_CHANGE_JUSTIFIED" : "CORRECTIVE_ACTION_REQUIRED",
    issues,
    evidence,
    previousRound: previous?.round ?? null,
    actions: issues.length === 0
      ? [
        "Keep the CAS guard and local freshness check as normative safety invariants.",
        "Do not add a re-read merely to improve a proxy metric; validate any coalescing against TOCTOU and event-loss cases.",
        "Compare the next round against the same task seed plus the planned harder volatility profile before changing policy."
      ]
      : [
        "Stop efficiency tuning until the unsafe or incomplete PREMiSE cases are reproduced by kind.",
        "Add a regression vector for every failing hard kind, then re-run the full blind control.",
        "Only accept a request/read reduction if safety remains unchanged on the frozen holdout."
      ]
  };
}

function improvementMarkdown({ plan, decision }) {
  return [
    `# Improvement review - ${plan.round}`,
    "",
    `Decision: **${decision.status}**`,
    "",
    `Tasks: ${plan.tasks}; volatility: ${plan.volatility}%; risk tiers: ${plan.riskLevels.join(", ")}.`,
    "",
    decision.issues.length === 0 ? "No safety regression justified a protocol mutation in this round." : `Issues: ${decision.issues.join("; ")}.`,
    "",
    "## Evidence",
    "",
    "```json",
    JSON.stringify(decision.evidence, null, 2),
    "```",
    "",
    "## Guarded next actions",
    "",
    ...decision.actions.map((action) => `- ${action}`),
    "",
    "> A benchmark result is not itself permission to tune against the same task set. The next round must preserve the blind mapping and use a frozen task manifest."
  ].join("\n");
}

function number(valueToFormat, digits = 1) {
  return typeof valueToFormat === "number" && Number.isFinite(valueToFormat) ? valueToFormat.toFixed(digits) : "UNKNOWN";
}

function ratioReduction(valueToFormat, baseline) {
  if (!Number.isFinite(valueToFormat) || !Number.isFinite(baseline) || baseline <= 0) return "UNKNOWN";
  return `${((1 - valueToFormat / baseline) * 100).toFixed(1)}%`;
}

function aggregateCampaign(campaign) {
  const rows = campaign.rounds.flatMap((round) => round.deterministicSummary?.results ?? []);
  const arms = [...new Set(rows.map((row) => row.arm))];
  return arms.map((arm) => {
    const values = rows.filter((row) => row.arm === arm);
    const sum = (key) => values.reduce((total, row) => total + (Number.isFinite(row[key]) ? row[key] : 0), 0);
    const tasks = sum("tasks");
    const completedTasks = sum("completedTasks");
    const attempts = sum("attempts");
    const unsafeActions = sum("unsafeActions");
    const connectorRequests = sum("connectorRequests");
    const externalReads = sum("externalReads");
    const visibleTokens = sum("visibleTokens");
    const visibleCostProxyUsd = sum("visibleCostProxyUsd");
    return {
      arm,
      tasks,
      completedTasks,
      attempts,
      safeCompletionPer100: tasks === 0 ? null : completedTasks * 100 / tasks,
      unsafeActions,
      unsafePer100Attempts: attempts === 0 ? null : unsafeActions * 100 / attempts,
      connectorRequests,
      requestsPerTask: tasks === 0 ? null : connectorRequests / tasks,
      externalReads,
      readsPerTask: tasks === 0 ? null : externalReads / tasks,
      visibleTokens,
      visibleTokensPerTask: tasks === 0 ? null : visibleTokens / tasks,
      visibleCostProxyUsd,
      csfaProxyUsd: completedTasks === 0 ? null : visibleCostProxyUsd / completedTasks
    };
  });
}

function campaignReport(campaign, args) {
  const aggregate = aggregateCampaign(campaign);
  const byArm = Object.fromEntries(aggregate.map((row) => [row.arm, row]));
  const liveAttempted = campaign.rounds.some((round) => round.llm.status !== "SKIPPED");
  const roundRows = campaign.rounds.map((round) => {
    const get = (arm) => round.deterministicSummary?.results.find((row) => row.arm === arm) ?? null;
    const premise = get("premise");
    const smart = get("smart");
    const always = get("always");
    return {
      round: round.round,
      tasks: round.tasks,
      volatility: round.volatility,
      premise,
      smart,
      always,
      premiseVsAlwaysRequests: premise && always ? ratioReduction(premise.connectorRequests / premise.tasks, always.connectorRequests / always.tasks) : "UNKNOWN",
      premiseVsAlwaysReads: premise && always ? ratioReduction(premise.externalReads / premise.tasks, always.externalReads / always.tasks) : "UNKNOWN",
      premiseVsSmartRequests: premise && smart ? ratioReduction(premise.connectorRequests / premise.tasks, smart.connectorRequests / smart.tasks) : "UNKNOWN",
      premiseVsSmartReads: premise && smart ? ratioReduction(premise.externalReads / premise.tasks, smart.externalReads / smart.tasks) : "UNKNOWN"
    };
  });
  return {
    format: "premisebench-agent/hard-ten-report/v1",
    status: campaign.status,
    plannedRounds: campaign.plan.length,
    executedRounds: campaign.rounds.length,
    plannedTasks: campaign.rounds.reduce((total, round) => total + round.tasks, 0),
    deterministicRows: aggregate,
    rounds: roundRows,
    llm: campaign.rounds.map((round) => round.llm),
    claims: {
      supported: [
        "Within this deterministic local control, all completed PREMiSE rounds report the recorded safety and I/O counts.",
        "The task generator includes filesystem-, Git-, PostgreSQL- and calendar-like payloads with hidden event/dependency metadata; the generic control executes snapshot/version/CAS and terminal mutation windows.",
        ...(liveAttempted
          ? ["The LLM adapter was invoked, but incomplete, payment-blocked, or rate-limited rounds are not ranked."]
          : ["The real-provider phase was explicitly skipped; no LLM ranking is claimed."])
      ],
      notSupported: [
        "Provider billing or monetary savings: provider cost is UNKNOWN and visible payload cost is synthetic.",
        "Production connector performance or connector-specific event/dependency semantics: the hard worlds are local simulations, not live GitHub, PostgreSQL or calendar services.",
        "A sealed independent holdout or inferential superiority claim: this campaign is descriptive and its round-by-round improvement review is rule-based.",
        "A claim that Luna Max changed the protocol: no external agent proposal is treated as a protocol mutation without a separately versioned challenger and later holdout.",
        "A universal LLM claim: a provider campaign that is partial, rate-limited, or sample-only is not a full-round LLM cohort and is not ranked."
      ],
      improvementPolicy: "No protocol mutation is accepted solely to reduce requests when the frozen safety control has no regression; every change must win a later holdout."
    },
    generatedAt: new Date().toISOString(),
    execution: {
      provider: args.provider,
      model: args.model,
      maxTokens: args.maxTokens,
      endpoint: args.endpoint,
      credentialEnv: args.credentialEnv,
      llmTasksPerRoundRequested: args.llmTasks
    }
  };
}

function reportMarkdown(report) {
  const rows = report.deterministicRows.map((row) => `| ${row.arm} | ${row.completedTasks}/${row.tasks} (${number(row.safeCompletionPer100)}%) | ${row.unsafeActions}/${row.attempts} (${number(row.unsafePer100Attempts)}%) | ${number(row.requestsPerTask, 2)} | ${number(row.readsPerTask, 2)} | ${number(row.visibleTokensPerTask, 0)} | ${row.csfaProxyUsd === null ? "UNKNOWN" : `$${number(row.csfaProxyUsd, 8)}`} |`);
  const roundRows = report.rounds.map((row) => `| ${row.round} | ${row.tasks} | ${row.volatility}% | ${row.premise ? `${row.premise.completedTasks}/${row.premise.tasks}` : "UNKNOWN"} | ${row.premise ? number(row.premise.connectorRequests / row.premise.tasks, 2) : "UNKNOWN"} | ${row.always ? number(row.always.connectorRequests / row.always.tasks, 2) : "UNKNOWN"} | ${row.premiseVsAlwaysRequests} | ${row.premiseVsAlwaysReads} |`);
  const llmRows = report.llm.map((row, index) => {
    const arms = row.arms ?? [];
    const total = (key) => {
      const values = arms.map((arm) => arm[key]).filter((value) => Number.isFinite(value));
      if (values.length === 0) return "UNKNOWN";
      const value = values.reduce((sum, item) => sum + item, 0);
      return values.length === arms.length ? String(value) : `${value}*`;
    };
    return `| r${String(index + 1).padStart(2, "0")} | ${row.status} | ${row.plannedTasks} | ${row.executedTasks} | ${row.fullCohort ? "yes" : "no"} | ${total("providerAttempts")} | ${total("inputTokens")} | ${total("outputTokens")} | UNKNOWN | ${row.provider} / ${row.model} |`;
  });
  return [
    "# PREMiSE hard twenty-round benchmark",
    "",
    `Status: **${report.status}** · deterministic tasks executed: **${report.plannedTasks}** · rounds: **${report.executedRounds}/${report.plannedRounds}**`,
    "",
    "> This is a local deterministic control plus an explicitly separated real-provider attempt. It is not a production or billing claim.",
    "",
    "## Aggregate safety and safe efficiency",
    "",
    "| Arm | Safe completions | Unsafe actions | Requests / task | Reads / task | Visible tokens / task | CSFA proxy |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "The denominators are explicit: deterministic safe completion and unsafe counts are out of tasks (one evaluated terminal action per task); the LLM report separately records observed intermediate action attempts and labels its unsafe rate task-level. Provider tokens and provider cost are UNKNOWN. CSFA proxy uses synthetic visible payload accounting and is not a provider price.",
    "",
    "## Progression by round",
    "",
    "| Round | Tasks | Volatility | PREMiSE safe | PREMiSE requests/task | Always requests/task | PREMiSE fewer requests vs Always | PREMiSE fewer reads vs Always |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...roundRows,
    "",
    "## Real LLM execution",
    "",
    "| Round | Status | Planned tasks | Executed tasks | Full cohort | Provider attempts | Input tokens | Output tokens | Provider cost | Provider / model |",
    "| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |",
    ...llmRows,
    "",
    "`*` marks a partial observed total from arms that reached the provider before the campaign stopped; it is not a complete cohort total.",
    "",
    "A rate-limited, incomplete, or sample-only LLM round is not ranked and does not contribute a safety percentage. The deterministic cohort and the optional LLM sample have separate denominators.",
    "",
    "## What this supports",
    "",
    ...report.claims.supported.map((claim) => `- ${claim}`),
    "",
    "## What this does not support",
    "",
    ...report.claims.notSupported.map((claim) => `- ${claim}`),
    "",
    `Improvement rule: ${report.claims.improvementPolicy}`
  ].join("\n");
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

export async function runCampaign(args) {
  await mkdir(args.output, { recursive: true });
  const campaign = {
    format: "premisebench-agent/hard-ten-rounds/v1",
    status: "RUNNING",
    plan: roundPlan,
    execution: { ...args, output: args.output, llmCredential: "provider adapter environment only; value never recorded" },
    rounds: []
  };
  await writeFile(resolve(args.output, "plan.json"), `${JSON.stringify(campaign, null, 2)}\n`, "utf8");
  let llmBlocked = false;

  for (const planned of roundPlan.filter(({ number }) => number >= args.start && number <= args.end)) {
    const name = roundName(planned.number);
    const plan = { ...planned, round: name, seed: args.seed + planned.number - 1, riskLevels: [...planned.riskLevels] };
    const directory = resolve(args.output, name);
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "plan.json"), `${JSON.stringify({ format: "premisebench-agent/hard-round/v1", ...plan, oracle: { exposedToAgent: false, evaluatorOnly: true }, llmTasksPlanned: args.llmTasks }, null, 2)}\n`, "utf8");

    const deterministic = await runNode([
      hardCampaignScript,
      `--tasks=${plan.tasks}`,
      `--seed=${plan.seed}`,
      `--round=${name}`,
      `--volatility=${plan.volatility}`,
      `--risk-levels=${plan.riskLevels.join(",")}`,
      `--output=${resolve(args.output, "deterministic")}`
    ]);
    await writeFile(resolve(directory, "deterministic-run.json"), `${JSON.stringify(deterministic, null, 2)}\n`, "utf8");
    const deterministicSummary = await readJson(resolve(args.output, "deterministic", name, "summary.json"));
    const previous = campaign.rounds.at(-1);
    const decision = improvementDecision(deterministicSummary, previous);
    await writeFile(resolve(directory, "improvement.json"), `${JSON.stringify(decision, null, 2)}\n`, "utf8");
    await writeFile(resolve(directory, "improvement.md"), `${improvementMarkdown({ plan, decision })}\n`, "utf8");

    let llm = { status: "SKIPPED", reason: args.skipLlm ? "--skip-llm" : args.llmTasks === 0 ? "--llm-tasks=0" : llmBlocked ? "previous-provider-failure" : null };
    if (!args.skipLlm && args.llmTasks > 0 && !llmBlocked) {
      const llmRound = `${name}-llm`;
      llm = await runNode([
        llmCampaignScript,
        `--provider=${args.provider}`,
        `--model=${args.model}`,
        `--max-tokens=${args.maxTokens}`,
        `--response-format=${args.responseFormat}`,
        "--scenario=hard",
        `--tasks=${Math.min(args.llmTasks, plan.tasks)}`,
        `--seed=${plan.seed}`,
        `--round=${llmRound}`,
        "--arms=all",
        "--max-retries=0",
        "--require-live",
        `--delay-ms=${args.delayMs}`,
        `--volatility=${plan.volatility}`,
        `--risk-levels=${plan.riskLevels.join(",")}`,
        ...(args.endpoint ? [`--endpoint=${args.endpoint}`] : []),
        ...(args.credentialEnv ? [`--credential-env=${args.credentialEnv}`] : []),
        `--output=${resolve(args.output, "llm")}`
      ], 1_800_000);
      llm.plannedTasks = Math.min(args.llmTasks, plan.tasks);
      llm.executedTasks = Number.isSafeInteger(llm.result?.executedLLMTasks)
        ? llm.result.executedLLMTasks
        : 0;
      llm.fullCohort = llm.plannedTasks === plan.tasks;
      llm.sampleOnly = !llm.fullCohort;
      llm.provider = args.provider;
      llm.model = args.model;
      llm.round = llmRound;
      if (llm.status === "ERROR" || ["PAYMENT_REQUIRED", "RATE_LIMITED", "ERROR", "NOT_RUN"].includes(llm.result?.status)) llmBlocked = true;
    }
    await writeFile(resolve(directory, "llm-run.json"), `${JSON.stringify(llm, null, 2)}\n`, "utf8");
    campaign.rounds.push({
      round: name,
      tasks: plan.tasks,
      volatility: plan.volatility,
      riskLevels: plan.riskLevels,
      deterministicStatus: deterministic.status,
      deterministicSummary: deterministicSummary ? {
        taskSetHash: deterministicSummary.taskSetHash,
        winner: deterministicSummary.winner,
        results: deterministicSummary.results.map(({ arm, metrics }) => ({
          arm,
          tasks: metrics.tasks,
          completedTasks: metrics.safeSuccessfulTasks,
          attempts: metrics.attempts,
          safeAttempts: metrics.safeAttempts,
          unsafeActions: metrics.unsafeActions,
          falseBlocks: metrics.falseBlocks,
          mutations: metrics.mutations,
          changesDetected: metrics.changesDetectedPer100,
          recovered: metrics.recoveredPer100,
          toctouEscapes: metrics.toctouEscapesPer100,
          connectorRequests: metrics.connectorRequests,
          externalReads: metrics.externalReads,
          externalWrites: metrics.externalWrites,
          localChecks: metrics.localChecks,
          visibleTokens: metrics.agentVisibleTokenProxy,
          visibleTokensPerTask: metrics.agentVisibleTokenProxyPerTask,
          visibleCostProxyUsd: metrics.agentVisibleCostProxy,
          providerTokens: metrics.providerTokens,
          providerCostUsd: metrics.providerCostUsd
        }))
      } : null,
      improvement: decision,
      llm: {
        status: (llm.result?.status ?? llm.status) === "OK" && llm.executedTasks === (llm.plannedTasks ?? 0) && llm.fullCohort === false
          ? "SAMPLE_ONLY"
          : llm.result?.status ?? llm.status,
        plannedTasks: llm.plannedTasks ?? 0,
        executedTasks: llm.executedTasks ?? 0,
        fullCohort: llm.fullCohort === true,
        sampleOnly: llm.sampleOnly === true,
        provider: args.provider,
        model: args.model,
        arms: (llm.result?.results ?? []).map((result) => {
          const metrics = result.metrics ?? result;
          return {
            arm: result.arm,
            status: result.status,
            completionRequests: metrics.completionRequests ?? null,
            providerAttempts: metrics.providerAttempts ?? null,
            inputTokens: metrics.inputTokens ?? null,
            outputTokens: metrics.outputTokens ?? null,
            providerCost: metrics.providerCost ?? null,
            externalReads: metrics.externalReads ?? null,
            externalWrites: metrics.externalWrites ?? null,
            usageStatus: metrics.usageStatus ?? null
          };
        })
      }
    });
    campaign.status = "RUNNING";
    await writeFile(resolve(args.output, "campaign-summary.json"), `${JSON.stringify(campaign, null, 2)}\n`, "utf8");
  }
  const llmGap = !args.skipLlm && args.llmTasks > 0 && campaign.rounds.some((round) => round.llm.status !== "OK" || round.llm.fullCohort !== true || round.llm.executedTasks !== round.llm.plannedTasks);
  const deterministicGap = campaign.rounds.some((round) => round.deterministicStatus !== "OK");
  const partialPlan = args.start !== 1 || args.end !== roundPlan.length;
  const deterministicOnly = args.skipLlm || args.llmTasks === 0;
  campaign.status = deterministicGap || llmGap
    ? (partialPlan ? "PARTIAL_WITH_GAPS" : "COMPLETE_WITH_GAPS")
    : deterministicOnly
      ? (partialPlan ? "PARTIAL_DETERMINISTIC_ONLY" : "COMPLETE_DETERMINISTIC_ONLY")
      : partialPlan ? "PARTIAL_PLAN" : "COMPLETE";
  campaign.completedAt = new Date().toISOString();
  await writeFile(resolve(args.output, "plan.json"), `${JSON.stringify({ ...campaign, planStatus: campaign.status }, null, 2)}\n`, "utf8");
  const report = campaignReport(campaign, args);
  campaign.report = { format: report.format, path: "report.md", status: report.status, plannedTasks: report.plannedTasks };
  await writeFile(resolve(args.output, "campaign-summary.json"), `${JSON.stringify(campaign, null, 2)}\n`, "utf8");
  await writeFile(resolve(args.output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(resolve(args.output, "tables.md"), `${reportMarkdown(report)}\n`, "utf8");
  await writeFile(resolve(args.output, "report.md"), `${reportMarkdown(report)}\n`, "utf8");
  if (args.requireLive && llmGap) process.exitCode = 1;
  return campaign;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await runCampaign(args);
  console.log(JSON.stringify({ status: result.status, output: args.output, rounds: result.rounds.map(({ round, tasks, deterministicStatus, llm }) => ({ round, tasks, deterministicStatus, llm })) }, null, 2));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

export { roundPlan };
