import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, availableParallelism, cpus, hostname, platform, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORMAT = "premise-ga-soak/1";
export const GA_THRESHOLDS = Object.freeze({
  minimumDurationMs: 60 * 60 * 1_000,
  minimumRequests: 10_000,
  minimumLatencySamples: 10_000,
  minimumAvailabilityRate: 0.999,
  maximumErrorRate: 0.001,
  maximumP95Ms: 500,
  maximumP99Ms: 2_000
});

const DEFAULT_OUTPUT = fileURLToPath(new URL("./results.json", import.meta.url));
const DEFAULTS = Object.freeze({
  baseUrl: "http://127.0.0.1:3000",
  durationMs: 30_000,
  concurrency: 4,
  requestTimeoutMs: 30_000,
  seedCount: 4,
  maxResponseBytes: 4 * 1024 * 1024,
  latencySampleSize: 100_000,
  healthPath: "/readyz",
  tenantId: "tenant:soak",
  operations: ["health", "capabilities", "register", "retrieve", "query", "source-changed"],
  output: DEFAULT_OUTPUT,
  enforceGa: false
});
const OPERATIONS = new Set(DEFAULTS.operations);
const ERROR_SAMPLE_LIMIT = 20;

class SoakError extends Error {
  constructor(message, kind, details = {}) {
    super(message);
    this.name = "SoakError";
    this.kind = kind;
    Object.assign(this, details);
  }
}

class Reservoir {
  constructor(limit, seed = 0x9e3779b9) {
    this.limit = limit;
    this.values = [];
    this.seen = 0;
    this.state = seed >>> 0;
  }

  add(value) {
    this.seen += 1;
    if (this.values.length < this.limit) {
      this.values.push(value);
      return;
    }
    this.state ^= this.state << 13;
    this.state ^= this.state >>> 17;
    this.state ^= this.state << 5;
    this.state >>>= 0;
    const slot = this.state % this.seen;
    if (slot < this.limit) this.values[slot] = value;
  }

  summary() {
    const sorted = [...this.values].sort((left, right) => left - right);
    const at = (fraction) => sorted.length === 0
      ? 0
      : round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]);
    return {
      method: "uniform-reservoir",
      reservoirSize: this.limit,
      samples: sorted.length,
      observations: this.seen,
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      p99Ms: at(0.99)
    };
  }
}

function round(value) {
  return Number(Number(value).toFixed(3));
}

function positiveInteger(value, flag, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${flag} must be a safe integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function environmentInteger(environment, name, fallback, options) {
  const value = environment[name];
  return value === undefined ? fallback : positiveInteger(value, name, options);
}

function argumentValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseOperations(value) {
  const operations = String(value).split(",").map((operation) => operation.trim()).filter(Boolean);
  if (operations.length === 0) throw new Error("operations must contain at least one operation");
  for (const operation of operations) if (!OPERATIONS.has(operation)) throw new Error(`unsupported operation: ${operation}`);
  return operations;
}

function publicBaseUrl(value) {
  const parsed = new URL(value);
  if (!/^https?:$/u.test(parsed.protocol)) throw new Error("base URL must use http or https");
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

function pathValue(value, flag) {
  if (typeof value !== "string" || !value.startsWith("/") || !/^[\x21-\x7e]+$/u.test(value)) throw new Error(`${flag} must be a printable path starting with /`);
  return value;
}

export function normalizeConfig(input = {}) {
  const config = {
    ...DEFAULTS,
    ...input,
    baseUrl: publicBaseUrl(input.baseUrl ?? DEFAULTS.baseUrl),
    durationMs: positiveInteger(input.durationMs ?? DEFAULTS.durationMs, "durationMs"),
    concurrency: positiveInteger(input.concurrency ?? DEFAULTS.concurrency, "concurrency"),
    requestTimeoutMs: positiveInteger(input.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs, "requestTimeoutMs"),
    seedCount: positiveInteger(input.seedCount ?? DEFAULTS.seedCount, "seedCount"),
    maxResponseBytes: positiveInteger(input.maxResponseBytes ?? DEFAULTS.maxResponseBytes, "maxResponseBytes"),
    latencySampleSize: positiveInteger(input.latencySampleSize ?? DEFAULTS.latencySampleSize, "latencySampleSize"),
    healthPath: pathValue(input.healthPath ?? DEFAULTS.healthPath, "healthPath"),
    tenantId: String(input.tenantId ?? DEFAULTS.tenantId),
    operations: Array.isArray(input.operations) ? parseOperations(input.operations.join(",")) : parseOperations(input.operations ?? DEFAULTS.operations.join(",")),
    output: input.output === null ? undefined : input.output === undefined ? DEFAULTS.output : path.resolve(String(input.output)),
    enforceGa: input.enforceGa === true
  };
  if (!/^[\x21-\x7e]{1,128}$/u.test(config.tenantId)) throw new Error("tenantId must be 1-128 printable ASCII characters");
  return config;
}

export function parseArgs(argv = process.argv.slice(2), environment = process.env) {
  const input = {
    baseUrl: environment.BASE_URL ?? DEFAULTS.baseUrl,
    durationMs: environment.PREMISE_SOAK_DURATION_MS,
    concurrency: environment.PREMISE_SOAK_CONCURRENCY,
    requestTimeoutMs: environment.PREMISE_SOAK_REQUEST_TIMEOUT_MS,
    seedCount: environment.PREMISE_SOAK_SEED_COUNT,
    maxResponseBytes: environment.PREMISE_SOAK_MAX_RESPONSE_BYTES,
    latencySampleSize: environment.PREMISE_SOAK_LATENCY_SAMPLE_SIZE,
    healthPath: environment.PREMISE_SOAK_HEALTH_PATH,
    tenantId: environment.PREMISE_TENANT_ID,
    operations: environment.PREMISE_SOAK_OPERATIONS,
    output: environment.PREMISE_SOAK_OUTPUT,
    enforceGa: false
  };
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inlineValue] = argument.split("=", 2);
    if (flag === "--help" || flag === "-h") {
      help = true;
      continue;
    }
    if (flag === "--enforce-ga") {
      input.enforceGa = true;
      continue;
    }
    const value = inlineValue ?? argumentValue(argv, index, flag);
    if (inlineValue === undefined) index += 1;
    switch (flag) {
      case "--base-url": input.baseUrl = value; break;
      case "--duration-ms": input.durationMs = value; break;
      case "--concurrency": input.concurrency = value; break;
      case "--request-timeout-ms": input.requestTimeoutMs = value; break;
      case "--seed-count": input.seedCount = value; break;
      case "--max-response-bytes": input.maxResponseBytes = value; break;
      case "--latency-sample-size": input.latencySampleSize = value; break;
      case "--health-path": input.healthPath = value; break;
      case "--tenant-id": input.tenantId = value; break;
      case "--operations": input.operations = value; break;
      case "--output": input.output = value; break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { help, config: help ? undefined : normalizeConfig(input) };
}

function help() {
  return `Usage: node benchmarks/ga-soak/runner.mjs [options]

The default 30-second run is smoke-only. It never qualifies as GA evidence.
Options:
  --base-url URL                 target BASE_URL (default: http://127.0.0.1:3000)
  --duration-ms N                measured window (default: 30000)
  --concurrency N                concurrent request loops (default: 4)
  --request-timeout-ms N         timeout per request (default: 30000)
  --seed-count N                 records written during setup (default: 4)
  --health-path PATH             readiness endpoint (default: /readyz)
  --tenant-id ID                 tenant header/envelope (default: tenant:soak)
  --operations LIST              comma-separated health,capabilities,register,retrieve,query,source-changed
  --latency-sample-size N        bounded percentile reservoir (default: 100000)
  --max-response-bytes N         response safety limit (default: 4194304)
  --output PATH                  result JSON path
  --enforce-ga                   exit non-zero unless the GA sample gates pass
  --help`;
}

function commitMetadata() {
  const environmentCommit = ["PREMISE_COMMIT", "GITHUB_SHA", "CI_COMMIT_SHA", "SOURCE_COMMIT"]
    .map((name) => ({ name, value: process.env[name] }))
    .find(({ value }) => typeof value === "string" && /^[0-9a-f]{7,64}$/iu.test(value));
  if (environmentCommit) return { value: environmentCommit.value, source: `env:${environmentCommit.name}` };
  try {
    const value = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (/^[0-9a-f]{40}$/iu.test(value)) return { value, source: "git" };
  } catch {
    // A production container may not contain git; the result remains explicit below.
  }
  return { value: "unknown", source: "unavailable" };
}

function hardwareMetadata() {
  const cpuList = cpus();
  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    cpuModel: cpuList[0]?.model ?? "unknown",
    logicalCpus: cpuList.length,
    availableParallelism: availableParallelism(),
    totalMemoryBytes: totalmem()
  };
}

function headers(config, method) {
  const value = {
    accept: "application/json",
    "cache-control": "no-store",
    "x-premise-tenant": config.tenantId,
    "x-request-id": randomUUID()
  };
  if (method === "POST") value["content-type"] = "application/json";
  if (typeof process.env.PREMISE_API_TOKEN === "string" && process.env.PREMISE_API_TOKEN.length > 0) {
    value.authorization = `Bearer ${process.env.PREMISE_API_TOKEN}`;
  }
  return value;
}

function endpoint(config, pathname) {
  return new URL(pathname, `${config.baseUrl}/`).toString();
}

async function requestJson(config, pathname, method = "GET", body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(endpoint(config, pathname), {
      method,
      headers: headers(config, method),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > config.maxResponseBytes) throw new SoakError("response exceeded safety limit", "response-too-large", { status: response.status });
    let parsed;
    try {
      parsed = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      throw new SoakError("response was not valid JSON", "invalid-json", { status: response.status });
    }
    if (!response.ok) {
      const code = typeof parsed?.error === "string" ? parsed.error : `HTTP_${response.status}`;
      throw new SoakError(`HTTP ${response.status}: ${code}`, "http", { status: response.status });
    }
    return { status: response.status, body: parsed };
  } catch (error) {
    if (error instanceof SoakError) throw error;
    if (error?.name === "AbortError" || error?.name === "TimeoutError") throw new SoakError("request timed out", "timeout");
    throw new SoakError("request failed", "network");
  } finally {
    clearTimeout(timeout);
  }
}

function requireProtocol(condition, message) {
  if (!condition) throw new SoakError(message, "protocol");
}

function contentFor(runId, index) {
  return `PREMiSE GA soak ${runId} seed ${index}`;
}

function recordFor(config, runId, index, kind = "seed") {
  const memoryId = `memory:ga-soak:${runId}:${kind}:${index}`;
  const sourceUri = `memory://ga-soak/${runId}/${kind}/${index}`;
  const observedAt = new Date().toISOString();
  return {
    memoryId,
    sourceUri,
    content: contentFor(runId, index),
    record: {
      envelope: {
        specVersion: "premise/2",
        tenantId: config.tenantId,
        memoryId,
        evidence: [{ evidenceId: `evidence:${memoryId}`, sourceUri, observedAt, version: { scheme: "ga-soak", token: "v1" }, validator: { id: "ga-soak", operation: "read" } }],
        confidence: { score: null, method: "ga-soak", assessedAt: observedAt },
        conflicts: [],
        temporal: { asOf: observedAt },
        validity: { status: "FRESH", checkedAt: observedAt, policy: "MANUAL" },
        dependsOn: [],
        signatures: []
      },
      content: contentFor(runId, index)
    }
  };
}

function validateHealth(body) {
  requireProtocol(body?.ok === true, "health endpoint did not report ok");
  if (body.ready !== undefined) requireProtocol(body.ready === true, "readiness endpoint did not report ready");
}

function validateCapabilities(body) {
  requireProtocol(body?.specVersion === "premise/2", "capabilities did not advertise premise/2");
}

function validateRegister(body, memoryId) {
  requireProtocol(body?.memoryId === memoryId, "register response did not return the memory ID");
}

function validateRetrieve(body, memoryId) {
  requireProtocol(body?.memoryId === memoryId || body?.envelope?.memoryId === memoryId, "retrieve response did not return the memory ID");
}

function validateQuery(body) {
  requireProtocol(body !== null && typeof body === "object" && body.context !== null && typeof body.context === "object", "query response did not include context");
}

function validateSourceChanged(body) {
  requireProtocol(Array.isArray(body?.affected), "source-change response did not include affected IDs");
}

async function runOperation(config, state, operation, sequence) {
  if (operation === "health") {
    const result = await requestJson(config, config.healthPath);
    validateHealth(result.body);
    return;
  }
  if (operation === "capabilities") {
    const result = await requestJson(config, "/v2/capabilities");
    validateCapabilities(result.body);
    return;
  }
  if (operation === "register") {
    const item = recordFor(config, state.runId, sequence, "live");
    const result = await requestJson(config, "/v2/memories", "POST", { record: item.record });
    validateRegister(result.body, item.memoryId);
    state.records.set(item.memoryId, item);
    return;
  }
  const seed = state.seedRecords[sequence % state.seedRecords.length];
  if (seed === undefined) throw new SoakError("no seed record is available for read operation", "setup");
  if (operation === "retrieve") {
    const result = await requestJson(config, `/v2/memories/${encodeURIComponent(seed.memoryId)}`);
    validateRetrieve(result.body, seed.memoryId);
    return;
  }
  if (operation === "query") {
    const result = await requestJson(config, "/v2/query", "POST", { query: "PREMiSE GA soak", maxTokens: 128 });
    validateQuery(result.body);
    return;
  }
  if (operation === "source-changed") {
    const result = await requestJson(config, "/v2/source-changed", "POST", { sourceUri: seed.sourceUri, version: { scheme: "ga-soak", token: `v${sequence + 2}` } });
    validateSourceChanged(result.body);
  }
}

function operationMetrics(config) {
  return Object.fromEntries(config.operations.map((operation) => [operation, { requests: 0, successful: 0, failed: 0, latency: new Reservoir(config.latencySampleSize, operation.length) }]));
}

function makeMetrics(config) {
  return {
    requests: 0,
    successful: 0,
    failed: 0,
    byOperation: operationMetrics(config),
    latency: new Reservoir(config.latencySampleSize),
    errors: { total: 0, byKind: {}, samples: [] }
  };
}

function classifyError(error) {
  return error instanceof SoakError ? error.kind : "unknown";
}

async function measure(config, state, metrics, operation, sequence) {
  const started = performance.now();
  let error;
  try {
    await runOperation(config, state, operation, sequence);
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }
  const durationMs = Math.max(0.001, performance.now() - started);
  const row = metrics.byOperation[operation];
  row.requests += 1;
  row.latency.add(durationMs);
  metrics.requests += 1;
  metrics.latency.add(durationMs);
  if (error === undefined) {
    row.successful += 1;
    metrics.successful += 1;
    return;
  }
  const kind = classifyError(error);
  row.failed += 1;
  metrics.failed += 1;
  metrics.errors.total += 1;
  metrics.errors.byKind[kind] = (metrics.errors.byKind[kind] ?? 0) + 1;
  if (metrics.errors.samples.length < ERROR_SAMPLE_LIMIT) {
    metrics.errors.samples.push({ operation, kind, message: error.message.slice(0, 200), ...(error.status === undefined ? {} : { status: error.status }) });
  }
}

async function setupTarget(config, runId) {
  const started = performance.now();
  const health = await requestJson(config, config.healthPath);
  validateHealth(health.body);
  const capabilities = await requestJson(config, "/v2/capabilities");
  validateCapabilities(capabilities.body);
  const seedRecords = [];
  for (let index = 0; index < config.seedCount; index += 1) {
    const item = recordFor(config, runId, index);
    const response = await requestJson(config, "/v2/memories", "POST", { record: item.record });
    validateRegister(response.body, item.memoryId);
    seedRecords.push(item);
  }
  return {
    ok: true,
    durationMs: round(performance.now() - started),
    preflight: { health: true, capabilities: true },
    seedRequested: config.seedCount,
    seedStored: seedRecords.length,
    seedRecords
  };
}

function rate(value, total) {
  return total === 0 ? 0 : round(value / total);
}

function summarizeMetrics(metrics) {
  const byOperation = Object.fromEntries(Object.entries(metrics.byOperation).map(([operation, row]) => [operation, {
    requests: row.requests,
    successful: row.successful,
    failed: row.failed,
    availabilityRate: rate(row.successful, row.requests),
    errorRate: rate(row.failed, row.requests),
    latency: row.latency.summary()
  }]));
  return {
    requests: metrics.requests,
    successful: metrics.successful,
    failed: metrics.failed,
    availabilityRate: rate(metrics.successful, metrics.requests),
    availabilityPercent: round(rate(metrics.successful, metrics.requests) * 100),
    errorRate: rate(metrics.failed, metrics.requests),
    latency: metrics.latency.summary(),
    byOperation,
    errors: metrics.errors
  };
}

function eligibility(config, setup, activeDurationMs, summary, commit) {
  const checks = {
    setup: { observed: setup.ok === true, required: true, passed: setup.ok === true },
    commit: { observed: commit.value, passed: commit.value !== "unknown" },
    duration: { observedMs: round(activeDurationMs), minimumMs: GA_THRESHOLDS.minimumDurationMs, passed: activeDurationMs >= GA_THRESHOLDS.minimumDurationMs },
    requests: { observed: summary.requests, minimum: GA_THRESHOLDS.minimumRequests, passed: summary.requests >= GA_THRESHOLDS.minimumRequests },
    latencySamples: { observed: summary.latency.observations, minimum: GA_THRESHOLDS.minimumLatencySamples, passed: summary.latency.observations >= GA_THRESHOLDS.minimumLatencySamples },
    availability: { observed: summary.availabilityRate, minimum: GA_THRESHOLDS.minimumAvailabilityRate, passed: summary.availabilityRate >= GA_THRESHOLDS.minimumAvailabilityRate },
    errorRate: { observed: summary.errorRate, maximum: GA_THRESHOLDS.maximumErrorRate, passed: summary.errorRate <= GA_THRESHOLDS.maximumErrorRate },
    latencyP95: { observedMs: summary.latency.p95Ms, maximumMs: GA_THRESHOLDS.maximumP95Ms, passed: Number.isFinite(summary.latency.p95Ms) && summary.latency.p95Ms <= GA_THRESHOLDS.maximumP95Ms },
    latencyP99: { observedMs: summary.latency.p99Ms, maximumMs: GA_THRESHOLDS.maximumP99Ms, passed: Number.isFinite(summary.latency.p99Ms) && summary.latency.p99Ms <= GA_THRESHOLDS.maximumP99Ms }
  };
  const eligibleForGa = Object.values(checks).every((check) => check.passed);
  const sampleType = activeDurationMs < GA_THRESHOLDS.minimumDurationMs ? "smoke" : "ga-candidate";
  const classification = eligibleForGa ? "ga-eligible" : sampleType === "smoke" ? "smoke-only" : "ga-candidate-failed";
  const reasons = Object.entries(checks).filter(([, check]) => !check.passed).map(([name]) => name);
  return {
    eligibleForGa,
    sampleType,
    classification,
    reasons,
    checks,
    thresholds: GA_THRESHOLDS,
    note: "Solo una ejecución que cumpla todas las comprobaciones y que sea revisada junto con su entorno y dataset puede usarse como evidencia GA; una prueba corta es smoke-only."
  };
}

function emptySetup(config, error) {
  return { ok: false, durationMs: 0, preflight: { health: false, capabilities: false }, seedRequested: config.seedCount, seedStored: 0, seedRecords: [], error: { kind: classifyError(error), message: error instanceof Error ? error.message : String(error) } };
}

export async function runSoak(input = {}) {
  const config = normalizeConfig(input);
  const runId = input.runId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let setup;
  try {
    setup = await setupTarget(config, runId);
  } catch (error) {
    setup = emptySetup(config, error);
  }

  const metrics = makeMetrics(config);
  const state = { runId, seedRecords: setup.seedRecords, records: new Map(), nextSequence: 0 };
  const measuredStart = performance.now();
  if (setup.ok) {
    const deadline = measuredStart + config.durationMs;
    const worker = async () => {
      while (performance.now() < deadline) {
        const sequence = state.nextSequence;
        state.nextSequence += 1;
        const operation = config.operations[sequence % config.operations.length];
        await measure(config, state, metrics, operation, sequence);
      }
    };
    await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
  }
  const ended = performance.now();
  const endedAt = new Date().toISOString();
  const summary = summarizeMetrics(metrics);
  const commit = commitMetadata();
  const hardware = hardwareMetadata();
  const result = {
    schema: FORMAT,
    format: FORMAT,
    benchmark: "ga-soak",
    runId,
    generatedAt: endedAt,
    source: { kind: "live-http", baseUrl: config.baseUrl, healthPath: config.healthPath },
    trace: { kind: "benchmark-run", runId, operations: config.operations },
    startedAt,
    endedAt,
    commit,
    runtime: { node: process.version, versions: { ...process.versions } },
    hardware,
    target: { baseUrl: config.baseUrl, tenantId: config.tenantId, healthPath: config.healthPath, authorizationConfigured: typeof process.env.PREMISE_API_TOKEN === "string" && process.env.PREMISE_API_TOKEN.length > 0 },
    configuration: {
      durationMs: config.durationMs,
      concurrency: config.concurrency,
      requestTimeoutMs: config.requestTimeoutMs,
      seedCount: config.seedCount,
      maxResponseBytes: config.maxResponseBytes,
      latencySampleSize: config.latencySampleSize,
      operations: config.operations
    },
    setup: { ...setup, seedRecords: setup.seedRecords.map(({ memoryId, sourceUri }) => ({ memoryId, sourceUri })) },
    window: { configuredDurationMs: config.durationMs, activeDurationMs: round(ended - measuredStart), wallClockDurationMs: round(ended - started) },
    metrics: summary,
    eligibility: eligibility(config, setup, ended - measuredStart, summary, commit),
    interpretation: {
      workload: "HTTP readiness plus real PREMiSE v2 capability, register, retrieve, query and source-change requests against BASE_URL.",
      availabilityDefinition: "successful semantic responses divided by measured requests; HTTP 2xx alone is not sufficient.",
      latencyDefinition: "p50/p95/p99 over a bounded uniform reservoir; observations reports the total seen by the runner.",
      claimsSupported: ["only this run, commit, configuration, target and hardware"],
      claimsNotSupported: ["universal capacity", "an SLA or availability guarantee", "external connector quality", "a short-run GA certification"]
    }
  };
  if (config.output !== undefined) {
    await mkdir(path.dirname(config.output), { recursive: true });
    await writeFile(config.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result;
}

async function main() {
  const parsed = parseArgs();
  if (parsed.help) {
    console.log(help());
    return;
  }
  const result = await runSoak(parsed.config);
  console.log(JSON.stringify({
    status: result.setup.ok ? "PASS" : "SETUP_FAILED",
    sampleType: result.eligibility.sampleType,
    classification: result.eligibility.classification,
    eligibleForGa: result.eligibility.eligibleForGa,
    requests: result.metrics.requests,
    availabilityRate: result.metrics.availabilityRate,
    errorRate: result.metrics.errorRate,
    p50Ms: result.metrics.latency.p50Ms,
    p95Ms: result.metrics.latency.p95Ms,
    p99Ms: result.metrics.latency.p99Ms,
    output: parsed.config.output
  }, null, 2));
  if (parsed.config.enforceGa && !result.eligibility.eligibleForGa) process.exitCode = 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
