import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + selector(row), 0);
}

function aggregate(rows) {
  const candidate = sum(rows, (row) => row.incremental.graphWork);
  const champion = sum(rows, (row) => row.champion.graphWork);
  const reference = sum(rows, (row) => row.reference.graphWork);
  return {
    rows: rows.length,
    candidate,
    champion,
    reference,
    reduction: champion === 0 ? null : 1 - candidate / champion,
    oracleReduction: reference === 0 ? null : 1 - candidate / reference,
    cacheHits: sum(rows, (row) => row.incremental.cacheHits),
    cacheMisses: sum(rows, (row) => row.incremental.cacheMisses),
    equivalent: rows.every((row) => row.equivalent === true),
    topologies: [...new Set(rows.map((row) => row.topology))].sort()
  };
}

function percent(value) {
  return value === null ? "—" : `${round(value * 100, 1)}%`;
}

function markdown(result, groups) {
  const lines = [
    "# PREMiSE Efficiency Lab — frontier report",
    "",
    `- Profile: **${result.profile}**` ,
    `- Baseline: **${result.baseline}** (immutable Champion)` ,
    `- Rows: **${result.campaigns.length}**` ,
    `- Reference equivalence: **${result.claims.referenceEquivalent ? "PASS" : "FAIL"}**` ,
    `- Commercial/safety claim: **not claimed by this report**` ,
    "",
    "The primary number is physical graph work (`nodesVisited + edgesTraversed`). It is not a token, provider-cost or safety result.",
    "",
    "## Champion comparison",
    "",
    "| Campaign | Candidate work | Champion work | Reduction vs Champion | Full reference work | Exact equivalence |",
    "| --- | ---: | ---: | ---: | ---: | :---: |"
  ];
  for (const [campaign, summary] of groups) {
    lines.push(`| ${campaign} | ${summary.candidate.toLocaleString("en-US")} | ${summary.champion.toLocaleString("en-US")} | ${percent(summary.reduction)} | ${summary.reference.toLocaleString("en-US")} | ${summary.equivalent ? "PASS" : "FAIL"} |`);
  }
  lines.push(
    "",
    "## Interpretation",
    "",
    "A reduction means fewer counted graph operations than the immediately preceding Champion for the same deterministic workload. The full reference is a correctness oracle and intentionally recomputes the relevant closure; it is not a production competitor.",
    "",
    "The report does not claim fewer external reads, tokens, dollars, unsafe actions or commercial savings. Those require the separate runtime/LLM campaigns and their own gates.",
    "",
    "## Out of scope",
    "",
    "Receipts, event continuity, single-flight and long-horizon compaction remain outside PR23 cycle 1. They must not be inferred from these rows."
  );
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = new Map(process.argv.slice(2).map((item) => {
    const [key, value = "true"] = item.replace(/^--/u, "").split("=", 2);
    return [key, value];
  }));
  const input = resolve(args.get("input") ?? ".tmp/premise-efficiency-lab/v1/frontier/large.json");
  const output = resolve(args.get("output") ?? ".tmp/premise-efficiency-lab/v1/frontier");
  const result = JSON.parse(await readFile(input, "utf8"));
  if (result.status !== "PASS") throw new Error(`Cannot report non-PASS campaign: ${result.status}`);
  const groups = new Map();
  for (const row of result.campaigns) {
    const rows = groups.get(row.campaign) ?? [];
    rows.push(row);
    groups.set(row.campaign, rows);
  }
  const summaries = Object.fromEntries([...groups].map(([campaign, rows]) => [campaign, aggregate(rows)]));
  const report = markdown(result, new Map(Object.entries(summaries)));
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "report.md"), report);
  await writeFile(resolve(output, "summary.json"), `${JSON.stringify({ format: "premise-efficiency-lab/frontier-summary/v1", profile: result.profile, baseline: result.baseline, claims: result.claims, campaigns: summaries }, null, 2)}\n`);
  process.stdout.write(JSON.stringify({ status: "PASS", profile: result.profile, campaigns: Object.keys(summaries), report: resolve(output, "report.md") }, null, 2) + "\n");
}

if (process.argv[1]?.endsWith("report.mjs")) await main();
