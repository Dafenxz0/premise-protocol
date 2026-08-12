import { mkdir, writeFile } from "node:fs/promises";
import { runCampaign } from "./runner.mjs";

const PROFILES = Object.freeze({
  smoke: { tasks: 24, nodeCount: 100, topologies: ["chain", "diamond", "mesh"] },
  "100": { tasks: 100, nodeCount: 100 },
  "1000": { tasks: 50, nodeCount: 1000 },
  "10000": { tasks: 20, nodeCount: 10000 },
  "diagnostic-100k": { tasks: 2, nodeCount: 100000, topologies: ["chain"] },
  "diagnostic-1m": { tasks: 1, nodeCount: 1000000, topologies: ["chain"] }
});

function options(argv) {
  const result = { profile: "smoke", seed: 20260812, volatility: 0.25, allowDiagnostic: false };
  for (let index = 0; index < argv.length; index += 1) {
    const [key, inline] = argv[index].split("=", 2);
    const value = inline ?? argv[++index];
    if (key === "--profile") result.profile = value;
    if (key === "--seed") result.seed = Number(value);
    if (key === "--volatility") result.volatility = Number(value);
    if (key === "--allow-diagnostic") result.allowDiagnostic = true;
  }
  return result;
}

const selected = options(process.argv.slice(2));
const profile = PROFILES[selected.profile];
if (!profile) throw new RangeError(`unknown profile: ${selected.profile}`);
if (selected.profile.startsWith("diagnostic-") && !selected.allowDiagnostic) {
  throw new Error(`${selected.profile} is diagnostic and requires --allow-diagnostic`);
}
const report = runCampaign({ ...profile, seed: selected.seed, volatility: selected.volatility });
report.scale = { profile: selected.profile, diagnostic: selected.profile.startsWith("diagnostic-") };
await mkdir(".tmp/premise-efficiency-lab", { recursive: true });
await writeFile(`.tmp/premise-efficiency-lab/scale-${selected.profile}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ scale: report.scale, config: report.config, safetyGate: report.safetyGate, claims: report.claims }, null, 2)}\n`);
