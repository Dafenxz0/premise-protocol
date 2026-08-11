import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const artifactDir = resolve(root, "benchmarks/premisebench-agent/artifacts");
const summary = JSON.parse(await readFile(resolve(artifactDir, "summary.json"), "utf8"));
const required = ["summary.json", "report.md", "tables.md", "traces.jsonl", "manifest.json", "dataset-manifest.json"];
for (const name of required) await readFile(resolve(artifactDir, name), "utf8");
if (summary.oracle?.exposedToAgent !== false || summary.oracle?.evaluatorOnly !== true) throw new Error("Oracle isolation metadata is not strict");
if (summary.campaign?.provider !== "deterministic-control") throw new Error("Smoke result is missing deterministic provider label");
if (!Array.isArray(summary.baselines) || summary.baselines.length !== 8) throw new Error("Expected eight baselines");
const traces = (await readFile(resolve(artifactDir, "traces.jsonl"), "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
for (const trace of traces) {
  if (trace.agentInput?.expected !== undefined || trace.agentInput?.oracle !== undefined || trace.agentInput?.groundTruth !== undefined || trace.agentInput?.mutation !== undefined || trace.agentInput?.outcome !== undefined) throw new Error(`Oracle leaked in ${trace.taskId}`);
}
console.log(`PremiseBench-Agent self-check: PASS (${traces.length} traces; oracle isolated)`);
