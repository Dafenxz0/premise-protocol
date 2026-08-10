import { HybridIndex } from "../dist/index.js";

const DOCUMENTS = Number(process.env.INDEX_HYBRID_BENCH_DOCUMENTS ?? 100_000);
const WARMUP_QUERIES = Number(process.env.INDEX_HYBRID_BENCH_WARMUP ?? 5);
const MEASURED_QUERIES = Number(process.env.INDEX_HYBRID_BENCH_QUERIES ?? 40);
const LIMIT = Number(process.env.INDEX_HYBRID_BENCH_LIMIT ?? 10);

if (!Number.isInteger(DOCUMENTS) || DOCUMENTS < 1) throw new Error("INDEX_HYBRID_BENCH_DOCUMENTS must be a positive integer");
if (!Number.isInteger(WARMUP_QUERIES) || WARMUP_QUERIES < 0) throw new Error("INDEX_HYBRID_BENCH_WARMUP must be a non-negative integer");
if (!Number.isInteger(MEASURED_QUERIES) || MEASURED_QUERIES < 1) throw new Error("INDEX_HYBRID_BENCH_QUERIES must be a positive integer");
if (!Number.isInteger(LIMIT) || LIMIT < 1) throw new Error("INDEX_HYBRID_BENCH_LIMIT must be a positive integer");

const vectorProvider = {
  name: "index-hybrid-benchmark-vector",
  mode: "external",
  embed: () => [1]
};

function percentile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * probability) - 1));
  return sorted[index];
}

function makeIndex() {
  return new HybridIndex({ vectorProvider, lexicalWeight: 1, vectorWeight: 0 });
}

async function load(index) {
  for (let indexNumber = 0; indexNumber < DOCUMENTS; indexNumber += 1) {
    await index.add({
      id: `bench:${String(indexNumber).padStart(7, "0")}`,
      text: `PREMiSE production query benchmark corpus document ${indexNumber % 17} ${indexNumber % 31}`,
      metadata: {
        tenantId: `tenant:${indexNumber % 4}`,
        acl: indexNumber % 5 === 0 ? "restricted" : "reader",
        freshness: indexNumber % 11 === 0 ? "stale" : "fresh"
      }
    });
  }
}

async function measure(index, options) {
  for (let indexNumber = 0; indexNumber < WARMUP_QUERIES; indexNumber += 1) {
    await index.search("PREMiSE production query benchmark", options);
  }
  const durations = [];
  let resultIds = [];
  for (let indexNumber = 0; indexNumber < MEASURED_QUERIES; indexNumber += 1) {
    const started = performance.now();
    const results = await index.search("PREMiSE production query benchmark", options);
    durations.push(performance.now() - started);
    resultIds = results.map(({ id }) => id);
  }
  return {
    documents: DOCUMENTS,
    limit: LIMIT,
    filter: options.filter ?? null,
    resultIds,
    p50Ms: percentile(durations, 0.50),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    minMs: Math.min(...durations),
    maxMs: Math.max(...durations)
  };
}

const index = makeIndex();
const loadStarted = performance.now();
await load(index);
const loadMs = performance.now() - loadStarted;
const unfiltered = await measure(index, { limit: LIMIT });
const tenantScoped = await measure(index, {
  limit: LIMIT,
  filter: { tenantId: "tenant:1", acl: "reader", freshness: "fresh" }
});

console.log(JSON.stringify({
  schema: "premise-index-hybrid-benchmark/1",
  node: process.version,
  loadMs,
  size: index.size,
  scenarios: { unfiltered, tenantScoped }
}, null, 2));
