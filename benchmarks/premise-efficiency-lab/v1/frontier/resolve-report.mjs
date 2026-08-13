import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

function markdown(result) {
  const lines = [
    "# PR26 incremental resolve evidence",
    "",
    `- Profile: **${result.profile}**`,
    `- Status: **${result.status}**`,
    `- Reference equivalence: **${result.claims.referenceEquivalent ? "PASS" : "FAIL"}**`,
    `- UNKNOWN fail-closed: **${result.claims.unknownFailClosed ? "PASS" : "FAIL"}**`,
    `- Accounting: **${result.claims.accountingReconciled ? "PASS" : "FAIL"}**`,
    "",
    "| Topology | Nodes | Resolve maintenance work | Total physical work | Tombstone entries at end | Eager closure diagnostic |",
    "| --- | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const row of result.rows) {
    lines.push(`| ${row.topology} | ${row.nodeCount} | ${row.resolveMaintenanceWork.toLocaleString("en-US")} | ${row.work.total.toLocaleString("en-US")} | ${row.tombstonedRootEntries} | ${row.peakEagerResolveClosure} |`);
  }
  lines.push(
    "",
    "The eager closure column is a locality diagnostic, not a measured Champion comparison. No performance or commercial reduction is claimed in this PR because an equally instrumented Champion N artifact is not yet available.",
    "",
    "Budget exhaustion, incomplete frontiers and UNKNOWN are safety outcomes and are never counted as successful optimization results."
  );
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = new Map(process.argv.slice(2).map((item) => {
    const [key, value = "true"] = item.replace(/^--/u, "").split("=", 2);
    return [key, value];
  }));
  const input = resolvePath(args.get("input") ?? ".tmp/premise-efficiency-lab/v1/frontier-resolve/smoke.json");
  const output = resolvePath(args.get("output") ?? ".tmp/premise-efficiency-lab/v1/frontier-resolve");
  const result = JSON.parse(await readFile(input, "utf8"));
  if (result.status !== "PASS") throw new Error(`Cannot report ${result.status} resolve campaign`);
  await mkdir(output, { recursive: true });
  await writeFile(resolvePath(output, "report.md"), markdown(result));
  await writeFile(resolvePath(output, "summary.json"), `${JSON.stringify({ format: "premise-efficiency-lab/frontier-resolve-summary/v1", profile: result.profile, claims: result.claims, rows: result.rows.map(({ topology, requestedSize, nodeCount, seed, work, resolveMaintenanceWork, tombstonedRootEntries, peakEagerResolveClosure }) => ({ topology, requestedSize, nodeCount, seed, work, resolveMaintenanceWork, tombstonedRootEntries, peakEagerResolveClosure })) }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: "PASS", report: resolvePath(output, "report.md") }, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("resolve-report.mjs")) await main();
