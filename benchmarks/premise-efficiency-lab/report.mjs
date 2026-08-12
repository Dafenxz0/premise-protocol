import { mkdir, writeFile } from "node:fs/promises";
import { runCampaign } from "./runner.mjs";

function parseArgs(argv) {
  const result = { tasks: 100, seed: 20260812, volatility: 0.25, nodeCount: 100 };
  for (let index = 0; index < argv.length; index += 1) {
    const [key, inline] = argv[index].split("=", 2);
    const value = inline ?? argv[index + 1];
    if (inline === undefined) index += 1;
    if (key === "--tasks") result.tasks = Number(value);
    if (key === "--seed") result.seed = Number(value);
    if (key === "--volatility") result.volatility = Number(value);
    if (key === "--nodes") result.nodeCount = Number(value);
    if (key === "--output") result.output = value;
  }
  return result;
}

function value(value, digits = 1) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "UNKNOWN";
}

function table(report) {
  const rows = Object.entries(report.candidates).map(([name, result]) => [
    name,
    `${value(result.safeCompletionRate)}%`,
    String(result.unsafeActions),
    String(result.requests),
    String(result.sourceReads),
    String(result.writes),
    value(result.requestsPerSafeCompletion, 2),
    String(result.externalWork),
    String(result.graphWork),
    String(result.protocolWork),
    value(result.workPerSafeCompletion, 2)
  ]);
  return [
    "# PREMiSE Efficiency Lab — internal calibration",
    "",
    `Tasks: ${report.config.tasks} · volatility: ${report.config.volatility} · seed: ${report.config.seed} · nodes: ${report.config.nodeCount}`,
    "",
    "This is a deterministic calibration artifact. It is not external, LLM or commercial evidence.",
    "",
    "| Policy | Safe completions | Unsafe actions | Requests | Reads | Writes | Requests / safe | External work | Graph work | Protocol work | Total work / safe |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
    `PREMiSE vs Always: requests ${value(report.comparisons.vsAlways.requestsReductionPct)}% · reads ${value(report.comparisons.vsAlways.readsReductionPct)}% · safe completion delta ${value(report.comparisons.vsAlways.safeCompletionDeltaPct)} points.`,
    `PREMiSE vs Smart: requests ${value(report.comparisons.vsSmart.requestsReductionPct)}% · reads ${value(report.comparisons.vsSmart.readsReductionPct)}% · safe completion delta ${value(report.comparisons.vsSmart.safeCompletionDeltaPct)} points.`,
    "",
    `Safety gate: PREMiSE unsafe actions = ${report.safetyGate.premiseUnsafeActions}; blind referee = ${report.blindEvaluation.status}; commercial claim ready = ${report.claims.commercialClaimReady}.`,
    ""
  ].join("\n");
}

const options = parseArgs(process.argv.slice(2));
const report = runCampaign(options);
const markdown = table(report);
const output = options.output ?? ".tmp/premise-efficiency-lab/report.md";
await mkdir(".tmp/premise-efficiency-lab", { recursive: true });
await writeFile(output, markdown, "utf8");
await writeFile(output.replace(/\.md$/u, ".json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(markdown);
