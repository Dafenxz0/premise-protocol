const UNKNOWN = "UNKNOWN";
const COUNTER_KEYS = Object.freeze([
  "requests", "reads", "writes", "nodes", "edges", "frontier",
  "dependencies", "invalidations", "reuse", "batching", "incrementality"
]);

function valueOf(source, key, fallback) {
  return source && Object.hasOwn(source, key) ? source[key] : fallback;
}

function add(left, right) {
  if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
  if (left === null || right === null) return null;
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
}

export function createCounters(source = {}) {
  const counters = Object.fromEntries(COUNTER_KEYS.map((key) => [key, valueOf(source, key, 0)]));
  const latency = valueOf(source, "latency", []);
  counters.latency = Array.isArray(latency) ? [...latency] : latency;
  return counters;
}

export function percentile(values, fraction = 0.5) {
  if (values === null || values === UNKNOWN) return values;
  if (!Array.isArray(values)) return UNKNOWN;
  if (values.length === 0) return null;
  if (values.includes(UNKNOWN)) return UNKNOWN;
  if (values.includes(null)) return null;
  if (!values.every(Number.isFinite)) return UNKNOWN;
  if (fraction === null || fraction === UNKNOWN) return fraction;
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return UNKNOWN;
  const probability = Math.min(1, Math.max(0, fraction > 1 ? fraction / 100 : fraction));
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * probability) - 1))];
}

export function mergeCounters(...inputs) {
  const sources = inputs.length === 1 && Array.isArray(inputs[0]) ? inputs[0] : inputs;
  const merged = createCounters();
  for (const key of COUNTER_KEYS) {
    let total;
    for (const source of sources) total = add(total, source?.[key]);
    merged[key] = total === undefined ? 0 : total;
  }

  let samples = [];
  let missing = false;
  let unknown = false;
  for (const source of sources) {
    const latency = source?.latency;
    if (latency === UNKNOWN) unknown = true;
    else if (latency === null) missing = true;
    else if (Array.isArray(latency)) samples.push(...latency);
  }
  merged.latency = unknown ? UNKNOWN : missing ? null : samples;
  return merged;
}

function ratio(actual, minimum) {
  if (actual === UNKNOWN || minimum === UNKNOWN) return UNKNOWN;
  if (actual === null || minimum === null) return null;
  if (typeof actual !== "number" || typeof minimum !== "number" || !Number.isFinite(actual) || !Number.isFinite(minimum) || minimum <= 0) return UNKNOWN;
  return actual / minimum;
}

export function workAmplification(actual, minimum) {
  if (actual && typeof actual === "object" && minimum && typeof minimum === "object" && !Array.isArray(actual) && !Array.isArray(minimum)) {
    const keys = new Set([...Object.keys(actual), ...Object.keys(minimum)]);
    return Object.fromEntries([...keys].filter((key) => key !== "latency").map((key) => [key, ratio(actual[key], minimum[key])]));
  }
  return ratio(actual, minimum);
}
