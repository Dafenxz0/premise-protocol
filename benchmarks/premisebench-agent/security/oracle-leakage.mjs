import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const path = resolve(root, "benchmarks/premisebench-agent/artifacts/traces.jsonl");
const forbidden = /oracle|groundTruth|expected|mutation|outcome/i;
const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
for (const line of lines) {
  const trace = JSON.parse(line);
  for (const key of Object.keys(trace.agentInput ?? {})) if (forbidden.test(key)) throw new Error(`forbidden field leaked: ${key}`);
}
console.log(`oracle leakage check: PASS (${lines.length} traces)`);
