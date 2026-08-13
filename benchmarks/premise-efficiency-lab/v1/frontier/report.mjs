import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const COUNTERS = Object.freeze([
  "graphNodeLookups", "graphEdgeTraversals", "reverseIndexLookups", "dirtyStateReads", "dirtyStateWrites",
  "frontierLookups", "frontierRootComparisons", "reachabilityQueries", "reachabilityCacheLookups", "reachabilityCacheHits",
  "reachabilityCacheMisses", "reachabilityCacheWrites", "reachabilityCacheEvictions", "reachabilityCacheEntriesCleared", "reachabilityNodesVisited",
  "reachabilityEdgesTraversed", "cacheLookups", "cacheEntriesScanned", "cacheEntriesPreserved",
  "cacheInvalidations", "cacheWrites", "rootSetReads", "rootSetWrites"
]);

function sum(rows, selector) {
  return rows.reduce((total, row) => total + (selector(row) ?? 0), 0);
}

function counterTotals(rows) {
  return Object.fromEntries(COUNTERS.map((key) => [key, sum(rows, (row) => row.incremental.primitiveCounters?.[key])]));
}

function aggregate(rows) {
  const candidateLegacy = sum(rows, (row) => row.incremental.graphWork);
  const candidatePhysical = sum(rows, (row) => row.incremental.physicalWork);
  const candidateGraph = sum(rows, (row) => row.incremental.physicalGraphWork);
  const baselineLegacy = sum(rows, (row) => row.baseline.graphWork);
  const reference = sum(rows, (row) => row.reference.graphWork);
  return {
    rows: rows.length,
    candidateLegacy,
    candidatePhysical,
    candidateGraph,
    baselineLegacy,
    reference,
    physicalReduction: null,
    oracleReduction: null,
    cacheHits: sum(rows, (row) => row.incremental.cacheHits),
    cacheMisses: sum(rows, (row) => row.incremental.cacheMisses),
    equivalent: rows.every((row) => row.equivalent === true),
    baselineEquivalent: rows.every((row) => row.baselineEquivalent === true),
    accountingReconciled: rows.every((row) => row.incremental.accountingReconciled === true),
    counters: counterTotals(rows),
    topologies: [...new Set(rows.map((row) => row.topology))].sort()
  };
}

function markdown(result, groups) {
  const lines = [
    "# PREMiSE Efficiency Lab - frontier evidence report",
    "",
    `- Profile: **${result.profile}**`,
    `- Rows: **${result.campaigns.length}**`,
    `- Baseline commit: **${result.baselineArtifact.commit}**`,
    `- Baseline artifact: **${result.baselineArtifact.artifactDigest}** (${result.baselineArtifact.artifactFiles} files)`,
    `- Baseline artifact verification: **${result.claims.baselineArtifactVerified ? "PASS" : "FAIL"}**`,
    `- Candidate/reference equivalence: **${result.claims.referenceEquivalent ? "PASS" : "FAIL"}**`,
    `- Candidate accounting reconciliation: **${result.claims.candidateAccountingReconciled ? "PASS" : "FAIL"}**`,
    `- Baseline behavior equivalence: **${result.claims.baselineBehaviorEquivalent ? "PASS" : "OBSERVED DIFFERENCES"}**`,
    "",
    "This is an evidence and instrumentation report, not a performance claim. The candidate reports physical primitive work; the historical baseline reports only its legacy graph counters. Those quantities are intentionally not divided into a reduction percentage until both implementations expose the same counter contract.",
    "",
    "## Campaign comparison",
    "",
    "| Campaign | Candidate physical work | Candidate graph work | Baseline legacy graph work | Full reference graph work | Exact candidate equivalence | Baseline behavior | Accounting |",
    "| --- | ---: | ---: | ---: | ---: | :---: | :---: | :---: |"
  ];
  for (const [campaign, summary] of groups) {
    lines.push(`| ${campaign} | ${summary.candidatePhysical.toLocaleString("en-US")} | ${summary.candidateGraph.toLocaleString("en-US")} | ${summary.baselineLegacy.toLocaleString("en-US")} | ${summary.reference.toLocaleString("en-US")} | ${summary.equivalent ? "PASS" : "FAIL"} | ${summary.baselineEquivalent ? "PASS" : "DIFFERENCES"} | ${summary.accountingReconciled ? "PASS" : "FAIL"} |`);
  }
  lines.push(
    "",
    "## How to read the numbers",
    "",
    "Physical work is the sum of the explicitly counted primitive operations for maintenance and query phases. Graph work is the subset covering graph lookups, graph edges and reachability traversal. Cache scans, state accesses and root comparisons remain visible in the physical total but are not silently relabeled as graph traversal.",
    "",
    "The baseline is the actual compiled artifact from the manifest commit. It is not the reconstructed reference implementation. Its legacy counters are retained for historical context, but no physical-work reduction is claimed against them because the old artifact does not emit the new primitive counters.",
    "",
    "The full reference is a correctness oracle, not a production competitor. This report makes no claims about external reads, tokens, provider cost, unsafe actions or commercial savings.",
    "",
    "## Out of scope for this PR",
    "",
    "Antichain optimization, incremental root removal, event continuity, receipts, single-flight changes, long-horizon compaction and any protocol semantic change remain blocked until this evidence contract is merged and the next candidate passes the same gates."
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
  await writeFile(resolve(output, "summary.json"), `${JSON.stringify({ format: "premise-efficiency-lab/frontier-summary/v2", profile: result.profile, baseline: result.baseline, baselineArtifact: result.baselineArtifact, claims: result.claims, campaigns: summaries }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: "PASS", profile: result.profile, campaigns: Object.keys(summaries), report: resolve(output, "report.md") }, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("report.mjs")) await main();
