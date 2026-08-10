import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { ContextEngine } from "../../packages/context-engine/dist/index.js";

const profilesArgument = process.argv.find((value) => value.startsWith("--profiles="));
const include1m = process.argv.includes("--include-1m");
const requestedProfiles = (profilesArgument?.slice("--profiles=".length) ?? "10000,100000").split(",").map(Number).filter((value) => Number.isSafeInteger(value) && value > 0);
const profiles = [...new Set(include1m ? requestedProfiles : requestedProfiles.filter((value) => value <= 100000))];
if (profiles.length === 0) throw new Error("No valid profiles supplied");

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

function makeCandidates(count) {
  const candidates = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const target = index === Math.floor(count * 0.777);
    candidates[index] = {
      id: `memory:${index}`,
      text: target ? `target fact release ${count} PREMiSE protocol context` : `document ${index} operational note`,
      score: target ? 1 : (index % 1000) / 1_000_000,
      freshness: index % 997 === 0 ? "STALE" : "FRESH",
      topic: `topic:${index % 64}`,
      metadata: { profile: count, target }
    };
  }
  return candidates;
}

async function measure(count) {
  const candidates = makeCandidates(count);
  const engine = new ContextEngine({ chunkSizeTokens: 32, diversityWeight: 0.2 });
  const latencies = [];
  let result;
  for (let run = 0; run < 3; run += 1) {
    const started = performance.now();
    result = engine.select({ candidates, tokenBudget: 128_000, maxChunks: 4096, maxSources: 4096, freshnessGate: { allowStale: false } });
    latencies.push(performance.now() - started);
  }
  const targetSelected = result.selected.some((item) => item.metadata?.target === true);
  return {
    memories: count,
    selectedChunks: result.selected.length,
    tokensUsed: result.tokensUsed,
    targetSelected,
    degraded: result.degraded,
    p50Ms: Number(percentile(latencies, 0.5).toFixed(3)),
    p95Ms: Number(percentile(latencies, 0.95).toFixed(3)),
    peakHeapMb: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)),
    traceEntries: result.trace.length
  };
}

const started = new Date().toISOString();
const results = [];
for (const profile of profiles) {
  console.log(`giant-context-v2: ${profile.toLocaleString()} memories`);
  results.push(await measure(profile));
}
const output = { benchmark: "giant-context-v2", generatedAt: started, node: process.version, include1m, tokenBudget: 128_000, results };
await mkdir(new URL("./", import.meta.url), { recursive: true });
await writeFile(new URL("./results.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`, "utf8");
const rows = results.map((row) => `| ${row.memories.toLocaleString()} | ${row.selectedChunks} | ${row.tokensUsed} | ${row.targetSelected ? "yes" : "no"} | ${row.p50Ms} ms | ${row.p95Ms} ms | ${row.peakHeapMb} MB |`).join("\n");
const report = [
  "# Giant context v2",
  "",
  `Node: **${process.version}**`,
  `Token budget: **128,000**`,
  `1M opt-in: **${include1m ? "yes" : "no"}**`,
  "",
  "| Memories | Selected | Tokens | Target kept | p50 | p95 | Heap after run |",
  "|---:|---:|---:|:---:|---:|---:|---:|",
  rows,
  "",
  "These are context-engine measurements, not model accuracy or a production capacity guarantee.",
  ""
].join("\n");
await writeFile(new URL("./report.md", import.meta.url), report, "utf8");
console.log(JSON.stringify(output, null, 2));
