import { createHash } from "node:crypto";

const UNKNOWN = new Set([null, undefined, "UNKNOWN", "NOT_RUN", "NOT_MEASURED"]);

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stable(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function seedNumber(seed) {
  const digest = createHash("sha256").update(stable(seed), "utf8").digest("hex");
  return Number.parseInt(digest.slice(0, 8), 16) >>> 0;
}

function random(seed) {
  let state = seedNumber(seed) || 1;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function valueAt(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (!UNKNOWN.has(value)) return finite(value);
  }
  return null;
}

export function safetyCostPoint(candidate, options = {}) {
  const safetyKeys = options.safetyKeys ?? ["safeCompletionRatePer100", "safeCompletionPer100", "completedRate", "safeCompletionRate"];
  const costKeys = options.costKeys ?? ["csfaUsd", "providerCsfa", "costPerSafeSuccessfulTaskUsd", "safeCostUsd"];
  const safety = valueAt(candidate?.metrics ?? candidate, safetyKeys);
  const cost = valueAt(candidate?.metrics ?? candidate, costKeys);
  return {
    id: candidate?.id ?? null,
    safety,
    cost,
    eligible: safety !== null && cost !== null,
    status: safety === null || cost === null ? "UNKNOWN" : "MEASURED"
  };
}

/** Return measured points for which no other point is at least as safe and no more expensive. */
export function paretoFrontier(candidates, options = {}) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  const points = candidates.map((candidate) => safetyCostPoint(candidate, options));
  return points.filter((point, index) => point.eligible && !points.some((other, otherIndex) => {
    if (!other.eligible || otherIndex === index) return false;
    const atLeastAsSafe = other.safety >= point.safety;
    const noMoreExpensive = other.cost <= point.cost;
    const strictlyBetter = other.safety > point.safety || other.cost < point.cost;
    return atLeastAsSafe && noMoreExpensive && strictlyBetter;
  }));
}

export function safetyCostCurve(candidates, options = {}) {
  return candidates.map((candidate) => safetyCostPoint(candidate, options))
    .sort((left, right) => (right.safety ?? -Infinity) - (left.safety ?? -Infinity) || (left.cost ?? Infinity) - (right.cost ?? Infinity) || String(left.id).localeCompare(String(right.id)));
}

export function groupByStrata(rows, dimensions = ["model", "domain", "volatility", "risk"]) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
  const groups = new Map();
  for (const row of rows) {
    const key = dimensions.map((dimension) => `${dimension}=${String(row?.[dimension] ?? "UNKNOWN")}`).join("|");
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return [...groups.entries()].map(([key, values]) => {
    const output = Object.fromEntries(key.split("|").map((part) => part.split("=")).map(([dimension, value]) => [dimension, value]));
    const safety = values.map((row) => valueAt(row.metrics ?? row, ["safeCompletionRatePer100", "safeCompletionPer100", "completedRate"])).filter((value) => value !== null);
    const unsafe = values.map((row) => valueAt(row.metrics ?? row, ["unsafeActionRatePer100", "unsafePer100", "unsafeRate"])).filter((value) => value !== null);
    const cost = values.map((row) => valueAt(row.metrics ?? row, ["csfaUsd", "providerCsfa", "safeCostUsd"])).filter((value) => value !== null);
    return {
      ...output,
      tasks: values.length,
      safeCompletionPer100: mean(safety),
      unsafePer100: mean(unsafe),
      csfa: mean(cost),
      costStatus: cost.length === values.length ? "MEASURED" : "UNKNOWN"
    };
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function bootstrapPairedDelta(left, right, options = {}) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) throw new TypeError("paired samples must have equal lengths");
  const paired = left.map((value, index) => {
    const a = finite(value);
    const b = finite(right[index]);
    return a === null || b === null ? null : a - b;
  }).filter((value) => value !== null);
  if (paired.length === 0) return { n: 0, estimate: null, low95: null, high95: null, status: "UNKNOWN" };
  const iterations = options.iterations ?? 2000;
  if (!Number.isSafeInteger(iterations) || iterations < 100) throw new RangeError("iterations must be an integer >= 100");
  const next = random(options.seed ?? "premise-frontier");
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < paired.length; index += 1) total += paired[Math.floor(next() * paired.length)];
    samples.push(total / paired.length);
  }
  return {
    n: paired.length,
    estimate: mean(paired),
    low95: quantile(samples, 0.025),
    high95: quantile(samples, 0.975),
    status: "MEASURED"
  };
}

export function publicFrontierReport(candidates, options = {}) {
  const curve = safetyCostCurve(candidates, options);
  const frontier = paretoFrontier(candidates, options);
  return {
    format: "premisebench-agent/scientific-frontier/v1",
    points: curve,
    frontier,
    unknownCostCandidates: curve.filter((point) => point.cost === null).map(({ id }) => id)
  };
}
