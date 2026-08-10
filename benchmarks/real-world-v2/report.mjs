import { readFile, writeFile } from "node:fs/promises";

const result = JSON.parse(await readFile(new URL("./results.json", import.meta.url), "utf8"));
const rows = result.strategies
  .map((strategy) => `| ${strategy.strategy} | ${strategy.correctPer100}/100 | ${strategy.requestsPer100}/100 | ${strategy.p50Ms} ms | ${strategy.p95Ms} ms | ${strategy.errorsPer100}/100 |`)
  .join("\n");
const report = `# PREMiSE v2 benchmark report

Run mode: **${result.mode}**

Tasks: **${result.tasks}**

Generated: **${result.generatedAt}**

## Simple numbers

| Strategy | Correct / 100 | Requests / 100 | p50 | p95 | Errors / 100 |
|---|---:|---:|---:|---:|---:|
${rows}

These are workload measurements, not product guarantees. "Correct" means exact equality with the benchmark truth for this run. Request count is a transparent cost proxy, not a billing quote.

## Scope and limitations

${result.limitations.map((limitation) => `- ${limitation}`).join("\n")}

Raw per-task traces are stored in [traces.jsonl](./traces.jsonl). Re-run the exact command and compare both the table and raw traces before making a claim.
`;
await writeFile(new URL("./report.md", import.meta.url), report, "utf8");
console.log(report);
