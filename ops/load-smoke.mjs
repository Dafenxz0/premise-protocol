const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const tenantId = process.env.PREMISE_TENANT_ID ?? "tenant:local";
const requests = integer("PREMISE_LOAD_REQUESTS", 32, 1, 2_000);
const concurrency = integer("PREMISE_LOAD_CONCURRENCY", 4, 1, 64);
const maxP95Ms = number("PREMISE_LOAD_MAX_P95_MS", 750, 1, 60_000);

function integer(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function number(name, fallback, minimum, maximum) {
  const value = Number.parseFloat(process.env[name] ?? String(fallback));
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} must be a number from ${minimum} to ${maximum}`);
  return value;
}

async function call(path, init = {}) {
  const started = performance.now();
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: { "content-type": "application/json", "x-premise-tenant": tenantId, ...(init.headers ?? {}) }
  });
  const body = await response.json();
  return { status: response.status, body, durationMs: performance.now() - started };
}

const failures = [];
const latencies = [];
let next = 0;
async function worker() {
  while (true) {
    const index = next++;
    if (index >= requests) return;
    const memoryId = `memory:load:${Date.now()}:${index}`;
    const at = new Date().toISOString();
    const envelope = {
      specVersion: "premise/2",
      tenantId,
      memoryId,
      evidence: [{ evidenceId: `evidence:${memoryId}`, sourceUri: `memory://${memoryId}`, observedAt: at }],
      confidence: { score: null, method: "load-smoke", assessedAt: at },
      conflicts: [],
      temporal: { asOf: at },
      validity: { status: "FRESH", checkedAt: at, policy: "MANUAL" },
      dependsOn: [],
      signatures: []
    };
    try {
      const result = await call("/v2/memories", { method: "POST", body: JSON.stringify({ record: { envelope, content: `load-${index}` } }) });
      latencies.push(result.durationMs);
      if (result.status !== 201) failures.push(`register ${index}: ${result.status}`);
    } catch (error) {
      failures.push(`register ${index}: ${error?.name ?? "request error"}`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
const sorted = [...latencies].sort((left, right) => left - right);
const p95 = sorted.length === 0 ? Number.POSITIVE_INFINITY : sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
const result = { ok: failures.length === 0 && p95 <= maxP95Ms, requests, concurrency, completed: latencies.length, p95Ms: Number(p95.toFixed(2)), maxP95Ms, failures: failures.slice(0, 5) };
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
