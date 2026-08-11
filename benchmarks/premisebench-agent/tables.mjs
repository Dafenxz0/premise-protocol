const number = (value) => value === null || value === undefined ? "—" : Number(value).toFixed(1);
const interval = (value) => value ? `${number(value.lower95)}–${number(value.upper95)}` : "—";

export function renderTables(summary) {
  const rows = summary.baselines;
  const lines = [
    "# PremiseBench-Agent tables",
    "",
    `Campaign: **${summary.campaign.provider}** · world: **${summary.campaign.world}** · tasks per row: **${summary.campaign.tasks}**`,
    "",
    "> These are deterministic control numbers from a temporary filesystem world. They validate the harness and causal state machine; they are not model-provider or production-SLA results.",
    "",
    "## Safety and outcome (per 100 tasks)",
    "",
    "| Baseline | Unsafe actions ↓ | Completed ↑ | Incorrect blocks ↓ | Changes detected ↑ | Recovered ↑ | TOCTOU escapes ↓ |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((row) => `| ${row.policy} · ${row.name} | ${number(row.unsafeActionsPer100)} | ${number(row.tasksCompletedPer100)} | ${number(row.falseBlocksPer100)} | ${number(row.changesDetectedPer100)} | ${number(row.recoveredPer100)} | ${number(row.toctouEscapesPer100)} |`),
    "",
    "## Cost and latency (per 100 tasks)",
    "",
    "| Baseline | Requests / 100 ↓ | Revalidations / 100 | Tokens / task* | p50 ms | p95 ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((row) => `| ${row.policy} · ${row.name} | ${number(row.requestsPer100)} | ${number(row.revalidationsPer100)} | ${number(row.tokensPerTask)} | ${number(row.p50Ms)} | ${number(row.p95Ms)} |`),
    "",
    "## Uncertainty (95% bootstrap)",
    "",
    "| Baseline | Unsafe actions / 100 | Completed / 100 | Recovered / 100 |",
    "| --- | ---: | ---: | ---: |",
    ...rows.map((row) => `| ${row.policy} · ${row.name} | ${interval(row.confidence95?.unsafeActionsPer100)} | ${interval(row.confidence95?.tasksCompletedPer100)} | ${interval(row.confidence95?.recoveredPer100)} |`),
    "",
    "*The smoke control uses no language model, so `0` is not a provider cost measurement. Real campaigns must report observed tokens and money separately. Lower request count is only a benefit when safety and completion remain acceptable.",
    ""
  ];
  return lines.join("\n");
}
