import { readFile, writeFile } from "node:fs/promises";

const result = JSON.parse(await readFile(new URL("./results.json", import.meta.url), "utf8"));
const format = (value) => value === null || value === undefined ? "—" : value;
const rows = result.strategies
  .map((strategy) => `| ${strategy.strategy} | ${strategy.baseline ? "Sí" : "No"} | ${strategy.protocol} | ${format(strategy.precisionPer100)}/100 | ${format(strategy.freshnessPer100)}/100 | ${format(strategy.requestsPer100)}/100 | ${format(strategy.costProxy.responseBytesPer100Tasks)} B/100 | ${format(strategy.p50Ms)} ms | ${format(strategy.p95Ms)} ms | ${format(strategy.errorsPer100)}/100 |`)
  .join("\n");
const postgres = result.connectors?.postgres;
const report = `# PREMiSE v2 benchmark report

Run mode: **${result.mode}**

Paired user tasks: **${result.tasks}**

Seed: **${result.seed}**

Generated: **${result.generatedAt}**

## Numbers people can read

Each row receives the same task order. **Precision** is exact answer equality;
errors count as wrong. **Freshness** requires both the answer and the observed
source version to match the evaluator's current label. Requests and bytes are
transparent cost proxies, not a billing quote.

| Strategy | Baseline | Protocol | Precise / 100 | Fresh / 100 | Requests / 100 | Response bytes / 100 | p50 | p95 | Errors / 100 |
|---|:---:|---|---:|---:|---:|---:|---:|---:|---:|
${rows}

The row marked **baseline = Sí / protocol = none** is the no-protocol control.
The PREMiSE rows are reference implementations for this benchmark and do not
by themselves prove production connector performance.

## Blindness and evidence

- Public task manifest: [tasks.json](./tasks.json), SHA-256 ${result.evidence.taskSet.sha256}.
- Hidden-label commitment: ${result.evidence.labels.sha256}. Answers are not exported.
- Raw per-task evidence: [traces.jsonl](./traces.jsonl), SHA-256 ${result.evidence.rawTrace.sha256} (${result.evidence.rawTrace.lines} lines).
- Claim boundary: **not eligible for a public product claim**; the run is not an independent attestation.

The evaluator retains labels separately in memory and only emits outcome flags,
versions, request metadata and hashes in the raw trace. Re-run the exact
command and compare the task manifest, table and raw trace before making a
claim.

## Connector evidence

${postgres ? `PostgreSQL mode: **${postgres.mode}**, read-only: **${postgres.readOnly}**, queries: **${postgres.metrics.requests}**, writes: **${postgres.writeRequests}**. This proves only that the configured connector can execute the declared SELECT/SHOW pack safely; it is not a write-capacity or efficacy result.` : "PostgreSQL connector: **not run**. It is opt-in and requires an explicit database URL."}

## Source and limitations

Source class: **${result.source.class}**. Read-only: **${result.source.readOnly}**. Network access: **${result.source.networkAccess}**.

${result.limitations.map((limitation) => `- ${limitation}`).join("\n")}
`;
await writeFile(new URL("./report.md", import.meta.url), report, "utf8");
console.log(report);
