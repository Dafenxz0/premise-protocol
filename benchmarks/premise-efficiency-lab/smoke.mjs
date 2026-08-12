import { mkdir, writeFile } from "node:fs/promises";
import { runCampaign } from "./runner.mjs";

const report = runCampaign({ tasks: 24, seed: 20260812, volatility: 0.5, nodeCount: 100 });
const output = ".tmp/premise-efficiency-lab/smoke-summary.json";
await mkdir(".tmp/premise-efficiency-lab", { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`PREMiSE Efficiency Lab smoke PASS\n${output}\n`);
for (const [name, result] of Object.entries(report.candidates)) {
  process.stdout.write(`${name}: safe=${result.safeCompletionRate?.toFixed(1)}% unsafe=${result.unsafeActionRate?.toFixed(1)}% requests/safe=${result.requestsPerSafeCompletion?.toFixed(2)}\n`);
}
