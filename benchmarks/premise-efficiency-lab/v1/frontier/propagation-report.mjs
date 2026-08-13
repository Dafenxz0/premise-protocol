import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

function formatWork(value) {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : "n/a";
}

function formatReduction(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function markdown(result) {
  const lines = [
    "# PR27 dirty propagation evidence",
    "",
    `- Profile: **${result.profile}**`,
    `- Status: **${result.status}**`,
    `- Candidate: ${result.candidate.commit} / ${result.candidate.artifactDigest} (dirty worktree: ${result.candidate.dirty ? "yes" : "no"})`,
    `- Baseline: ${result.baseline.commit} / ${result.baseline.artifactDigest}`,
    `- Reference equivalence: **${result.claims.referenceEquivalent ? "PASS" : "FAIL"}**`,
    `- Counter reconciliation: **${result.claims.accountingReconciled ? "PASS" : "FAIL"}**`,
    `- UNKNOWN/budget fail-closed: **${result.claims.unknownFailClosed && result.claims.budgetFailClosed ? "PASS" : "FAIL"}**`,
    `- Exhaustive smoke lane: **${result.exhaustive.status}**`,
    `- Targeted locality gate: **${result.claims.localityPerformanceGate ? "PASS" : "INCONCLUSIVE"}**`,
    `- Median locality reduction: **${result.claims.localityMedianReduction === null ? "n/a" : `${(result.claims.localityMedianReduction * 100).toFixed(1)}%`}**`,
    "",
    "| Scenario | Nodes | Events | Candidate primitive work | Baseline primitive work | Reduction | Comparable |",
    "| --- | ---: | ---: | ---: | ---: | ---: | :---: |"
  ];
  for (const row of result.rows) {
    lines.push(`| ${row.name} | ${row.nodeCount.toLocaleString("en-US")} | ${row.eventCount.toLocaleString("en-US")} | ${formatWork(row.candidatePhysicalWork)} | ${formatWork(row.baselinePhysicalWork)} | ${formatReduction(row.reduction)} | ${row.comparable ? "PASS" : "NO"} |`);
  }
  lines.push(
    "",
    "Primitive work is the sum of the 17 physical counters across maintenance and query phases. Initialization is retained inside each operation breakdown but is excluded from the action-time comparison.",
    "Warm-up work is retained per row in summary.json and is excluded from the action-time comparison by design; it is not silently treated as zero.",
    "",
    "The full traversal implementation is a semantic oracle, not a cost denominator. The baseline is the independently compiled artifact recorded in the manifest and is verified before execution.",
    "",
    "This is a deterministic calibration campaign, not a blind external evaluation. It makes no claim about tokens, provider cost, external requests, commercial savings or general LLM behavior.",
    "",
    "An INCONCLUSIVE result means the safety and accounting gates passed but the targeted performance gate did not. It must not be presented as a win."
  );
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = new Map(process.argv.slice(2).map((item) => {
    const [key, value = "true"] = item.replace(/^--/u, "").split("=", 2);
    return [key, value];
  }));
  const input = resolvePath(args.get("input") ?? ".tmp/premise-efficiency-lab/v1/frontier-propagation/smoke.json");
  const output = resolvePath(args.get("output") ?? ".tmp/premise-efficiency-lab/v1/frontier-propagation/smoke");
  const result = JSON.parse(await readFile(input, "utf8"));
  if (result.status !== "PASS") throw new Error(`Cannot report ${result.status} propagation campaign`);
  await mkdir(output, { recursive: true });
  await writeFile(resolvePath(output, "report.md"), markdown(result));
  await writeFile(resolvePath(output, "summary.json"), `${JSON.stringify({
    format: "premise-efficiency-lab/frontier-propagation-summary/v1",
    profile: result.profile,
    status: result.status,
    candidate: result.candidate,
    baseline: result.baseline,
    claims: result.claims,
    rows: result.rows.map(({ name, nodeCount, eventCount, candidatePhysicalWork, baselinePhysicalWork, reduction, comparable, equivalent, accountingReconciled, warmupWork, candidateWork, baselineWork, candidateStats, baselineStats }) => ({ name, nodeCount, eventCount, candidatePhysicalWork, baselinePhysicalWork, reduction, comparable, equivalent, accountingReconciled, warmupWork, candidateWork, baselineWork, candidateStats, baselineStats }))
  }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: "PASS", report: resolvePath(output, "report.md") }, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("propagation-report.mjs")) await main();
