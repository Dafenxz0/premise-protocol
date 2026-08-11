import { execFileSync } from "node:child_process";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { arch, availableParallelism, cpus, hostname, platform, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSignedEnvelopeClient } from "../ga-load/signed-envelope-client.mjs";

export const FORMAT = "premise-ga-soak/1";
export const TRACE_FORMAT = "premise-ga-soak/trace/1";
export const REQUIRED_OPERATIONS = Object.freeze([
  "health",
  "capabilities",
  "register",
  "retrieve",
  "query",
  "source-changed"
]);
export const GA_THRESHOLDS = Object.freeze({
  minimumDurationMs: 60 * 60 * 1_000,
  minimumRequests: 10_000,
  minimumLatencySamples: 10_000,
  minimumAvailabilityRate: 0.999,
  maximumErrorRate: 0.001,
  minimumOperationRequests: 100,
  maximumP95Ms: 500,
  maximumP99Ms: 2_000,
  requiredOperations: REQUIRED_OPERATIONS
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
  rawTraceLimit: 10_000,
  healthPath: "/readyz",
  livenessPath: "/health",
  tenantId: "tenant:soak",
  operations: ["health", "capabilities", "register", "retrieve", "query", "source-changed"],
  output: DEFAULT_OUTPUT,
  enforceGa: false
});
const OPERATIONS = new Set(DEFAULTS.operations);
const ERROR_SAMPLE_LIMIT = 20;

class TraceWriter {
  constructor({ output, limit, runId }) {
    this.output = output;
    this.limit = limit;
    this.runId = runId;
    this.events = [];
    this.totalEvents = 0;
    this.truncated = false;
    this.writeError = null;
    this.pending = Promise.resolve();
    this.hash = createHash("sha256");
    this.handle = undefined;
  }

  async open() {
    if (this.output !== undefined) {
      await mkdir(path.dirname(this.output), { recursive: true });
      this.handle = await open(this.output, "w", 0o600);
    }
    return this;
  }

  record(event) {
    const row = {
      schema: TRACE_FORMAT,
      runId: this.runId,
      ...event
    };
    this.totalEvents += 1;
    if (this.events.length < this.limit) this.events.push(row);
    else this.truncated = true;
    if (this.handle !== undefined) {
      const line = `${JSON.stringify(row)}\n`;
      this.pending = this.pending.then(async () => {
        if (this.writeError !== null) return;
        try {
          await this.handle.write(line, undefined, "utf8");
          this.hash.update(line, "utf8");
        } catch (error) {
          this.writeError ??= error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
        }
      });
    }
  }

  async close() {
    await this.pending;
    if (this.handle !== undefined) {
      await this.handle.close();
      this.handle = undefined;
    }
  }

  summary() {
    return {
      kind: "raw-jsonl",
      format: TRACE_FORMAT,
      path: this.output === undefined ? null : path.basename(this.output),
      sha256: this.output === undefined || this.writeError !== null ? null : `sha256:${this.hash.digest("hex")}`,
      totalEvents: this.totalEvents,
      retainedEvents: this.events.length,
      truncated: this.truncated,
      writeError: this.writeError,
      events: this.events
    };
  }
}

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
  const output = input.output === null ? undefined : input.output === undefined ? DEFAULTS.output : path.resolve(String(input.output));
  const traceOutput = input.traceOutput === null || input.traceOutput === undefined
    ? undefined
    : path.resolve(String(input.traceOutput));
  if (output !== undefined && traceOutput !== undefined && output === traceOutput) {
    throw new Error("traceOutput must be different from output");
  }
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
    rawTraceLimit: positiveInteger(input.rawTraceLimit ?? DEFAULTS.rawTraceLimit, "rawTraceLimit"),
    healthPath: pathValue(input.healthPath ?? DEFAULTS.healthPath, "healthPath"),
    livenessPath: pathValue(input.livenessPath ?? DEFAULTS.livenessPath, "livenessPath"),
    tenantId: String(input.tenantId ?? DEFAULTS.tenantId),
    operations: Array.isArray(input.operations) ? parseOperations(input.operations.join(",")) : parseOperations(input.operations ?? DEFAULTS.operations.join(",")),
    output,
    traceOutput,
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
    rawTraceLimit: environment.PREMISE_SOAK_RAW_TRACE_LIMIT,
    healthPath: environment.PREMISE_SOAK_HEALTH_PATH,
    livenessPath: environment.PREMISE_SOAK_LIVENESS_PATH,
    tenantId: environment.PREMISE_TENANT_ID,
    operations: environment.PREMISE_SOAK_OPERATIONS,
    output: environment.PREMISE_SOAK_OUTPUT,
    traceOutput: environment.PREMISE_SOAK_TRACE_OUTPUT,
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
      case "--raw-trace-limit": input.rawTraceLimit = value; break;
      case "--health-path": input.healthPath = value; break;
      case "--liveness-path": input.livenessPath = value; break;
      case "--tenant-id": input.tenantId = value; break;
      case "--operations": input.operations = value; break;
      case "--output": input.output = value; break;
      case "--trace-output": input.traceOutput = value; break;
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
  --liveness-path PATH           liveness endpoint (default: /health)
  --tenant-id ID                 tenant header/envelope (default: tenant:soak)
  --operations LIST              comma-separated health,capabilities,register,retrieve,query,source-changed
  --latency-sample-size N        bounded percentile reservoir (default: 100000)
  --raw-trace-limit N            raw events retained in the JSON result (default: 10000)
  --max-response-bytes N         response safety limit (default: 4194304)
  --output PATH                  result JSON path
  --trace-output PATH             complete raw request JSONL trace path
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

function headers(config, method, idempotencyKey, requestId) {
  const value = {
    accept: "application/json",
    "cache-control": "no-store",
    "x-premise-tenant": config.tenantId,
    "x-request-id": requestId
  };
  if (method === "POST") value["content-type"] = "application/json";
  if (method === "POST" && typeof idempotencyKey === "string") value["idempotency-key"] = idempotencyKey;
  if (typeof process.env.PREMISE_API_TOKEN === "string" && process.env.PREMISE_API_TOKEN.length > 0) {
    value.authorization = `Bearer ${process.env.PREMISE_API_TOKEN}`;
  }
  return value;
}

function endpoint(config, pathname) {
  return new URL(pathname, `${config.baseUrl}/`).toString();
}

async function responseText(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
    throw new SoakError("response exceeded safety limit", "response-too-large", { status: response.status });
  }
  if (response.body?.getReader === undefined) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new SoakError("response exceeded safety limit", "response-too-large", { status: response.status });
    }
    return { text, bytes: Buffer.byteLength(text, "utf8") };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new SoakError("response exceeded safety limit", "response-too-large", { status: response.status });
      }
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return { text: chunks.join(""), bytes };
  } finally {
    reader.releaseLock();
  }
}

function requestMeta(requestId, startedAt, started, pathname, method, status, responseRequestId, responseBytes) {
  return {
    requestId,
    responseRequestId: responseRequestId ?? null,
    method,
    path: pathname,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: round(Math.max(0.001, performance.now() - started)),
    status: status ?? null,
    responseBytes: responseBytes ?? 0
  };
}

function normalizedRequestError(error, config, timedOut, interrupted, meta) {
  if (error instanceof SoakError) {
    error.requestMeta = meta;
    return error;
  }
  if (interrupted || (error?.name === "AbortError" && config.abortSignal?.aborted === true && !timedOut)) {
    return new SoakError("soak run interrupted", "interrupted", { requestMeta: meta });
  }
  if (timedOut || error?.name === "AbortError" || error?.name === "TimeoutError") {
    return new SoakError("request timed out", "timeout", { requestMeta: meta });
  }
  return new SoakError("request failed", "network", { requestMeta: meta });
}

async function requestJson(config, pathname, method = "GET", body, idempotencyKey, traceContext = {}) {
  const requestId = randomUUID();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  let interrupted = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.requestTimeoutMs);
  const abortExternal = () => {
    interrupted = true;
    controller.abort();
  };
  if (config.abortSignal !== undefined) {
    if (config.abortSignal.aborted) abortExternal();
    else config.abortSignal.addEventListener("abort", abortExternal, { once: true });
  }
  let status;
  let responseRequestId;
  let responseBytes = 0;
  let failure;
  try {
    const response = await fetch(endpoint(config, pathname), {
      method,
      headers: headers(config, method, idempotencyKey, requestId),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    status = response.status;
    responseRequestId = response.headers.get("x-request-id") ?? undefined;
    const payload = await responseText(response, config.maxResponseBytes);
    responseBytes = payload.bytes;
    const text = payload.text;
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
    const meta = requestMeta(requestId, startedAt, started, pathname, method, status, responseRequestId, responseBytes);
    failure = normalizedRequestError(error, config, timedOut, interrupted, meta);
    throw failure;
  } finally {
    clearTimeout(timeout);
    if (config.abortSignal !== undefined) config.abortSignal.removeEventListener("abort", abortExternal);
    const meta = requestMeta(requestId, startedAt, started, pathname, method, status, responseRequestId, responseBytes);
    const trace = traceContext.trace ?? config.traceWriter;
    trace?.record({
      event: "http",
      phase: traceContext.phase ?? "measured",
      operation: traceContext.operation ?? "unknown",
      probe: traceContext.probe ?? null,
      sequence: traceContext.sequence ?? null,
      ...meta,
      ok: failure === undefined,
      error: failure === undefined ? null : { kind: classifyError(failure), message: failure.message.slice(0, 240), ...(failure.status === undefined ? {} : { status: failure.status }) }
    });
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

function validateHealth(body, { readiness = false } = {}) {
  requireProtocol(body?.ok === true, "health endpoint did not report ok");
  if (readiness) requireProtocol(body?.ready === true, "readiness endpoint did not report ready");
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
  const call = (pathname, method = "GET", body, idempotencyKey, probe = null) => requestJson(
    config,
    pathname,
    method,
    body,
    idempotencyKey,
    { trace: state.trace, operation, sequence, probe, phase: "measured" }
  );
  if (operation === "health") {
    const liveness = await call(config.livenessPath, "GET", undefined, undefined, "liveness");
    validateHealth(liveness.body);
    if (config.healthPath !== config.livenessPath) {
      const readiness = await call(config.healthPath, "GET", undefined, undefined, "readiness");
      validateHealth(readiness.body, { readiness: true });
    } else {
      validateHealth(liveness.body, { readiness: true });
    }
    return;
  }
  if (operation === "capabilities") {
    const result = await call("/v2/capabilities");
    validateCapabilities(result.body);
    return;
  }
  if (operation === "register") {
    const item = recordFor(config, state.runId, sequence, "live");
    const envelope = state.signer === undefined ? item.record.envelope : state.signer.signEnvelope(item.record.envelope, { signatureId: `sig:ga-soak:${state.runId}:live:${sequence}`, evidenceId: item.record.envelope.evidence[0]?.evidenceId });
    const result = await call("/v2/memories", "POST", { record: { ...item.record, envelope } }, `ga-soak:${state.runId}:live:${sequence}`);
    validateRegister(result.body, item.memoryId);
    return;
  }
  const seed = state.seedRecords[sequence % state.seedRecords.length];
  if (seed === undefined) throw new SoakError("no seed record is available for read operation", "setup");
  if (operation === "retrieve") {
    const result = await call(`/v2/memories/${encodeURIComponent(seed.memoryId)}`);
    validateRetrieve(result.body, seed.memoryId);
    return;
  }
  if (operation === "query") {
    const result = await call("/v2/query", "POST", { query: "PREMiSE GA soak", maxTokens: 128 }, `ga-soak:${state.runId}:query:${sequence}`);
    validateQuery(result.body);
    return;
  }
  if (operation === "source-changed") {
    const result = await call("/v2/source-changed", "POST", { sourceUri: seed.sourceUri, version: { scheme: "ga-soak", token: `v${sequence + 2}` } }, `ga-soak:${state.runId}:source:${seed.memoryId}:${sequence}`);
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
  if (operation === "health") updateReadiness(state, error);
  state.trace?.record({
    event: "operation",
    phase: "measured",
    operation,
    sequence,
    startedAt: new Date(Date.now() - durationMs).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: round(durationMs),
    ok: error === undefined,
    error: error === undefined ? null : { kind: classifyError(error), message: error.message.slice(0, 240), ...(error.status === undefined ? {} : { status: error.status }) }
  });
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

function updateReadiness(state, error) {
  const readiness = state.readiness;
  readiness.probes += 1;
  if (error === undefined) {
    readiness.successful += 1;
    if (readiness.activeOutage !== null) {
      const endedAt = new Date().toISOString();
      readiness.activeOutage.endedAt = endedAt;
      readiness.activeOutage.durationMs = round(Math.max(0, Date.parse(endedAt) - Date.parse(readiness.activeOutage.startedAt)));
      readiness.outages.push(readiness.activeOutage);
      readiness.activeOutage = null;
    }
    readiness.state = "ready";
    return;
  }
  readiness.failed += 1;
  if (readiness.activeOutage === null) {
    readiness.activeOutage = { startedAt: new Date().toISOString(), endedAt: null, durationMs: null, errorKind: classifyError(error) };
  }
  readiness.state = "not-ready";
}

async function setupTarget(config, runId, signer) {
  const started = performance.now();
  const traceContext = (operation, probe = null) => ({ trace: config.traceWriter, operation, probe, phase: "setup", sequence: null });
  const liveness = await requestJson(config, config.livenessPath, "GET", undefined, undefined, traceContext("health", "liveness"));
  validateHealth(liveness.body);
  let readiness = liveness;
  if (config.healthPath !== config.livenessPath) {
    readiness = await requestJson(config, config.healthPath, "GET", undefined, undefined, traceContext("health", "readiness"));
  }
  validateHealth(readiness.body, { readiness: true });
  const capabilities = await requestJson(config, "/v2/capabilities", "GET", undefined, undefined, traceContext("capabilities"));
  validateCapabilities(capabilities.body);
  const seedRecords = [];
  for (let index = 0; index < config.seedCount; index += 1) {
    const item = recordFor(config, runId, index);
    const envelope = signer === undefined ? item.record.envelope : signer.signEnvelope(item.record.envelope, { signatureId: `sig:ga-soak:${runId}:seed:${index}`, evidenceId: item.record.envelope.evidence[0]?.evidenceId });
    const response = await requestJson(config, "/v2/memories", "POST", { record: { ...item.record, envelope } }, `ga-soak:${runId}:seed:${index}`, traceContext("register"));
    validateRegister(response.body, item.memoryId);
    seedRecords.push(item);
  }
  return {
    ok: true,
    durationMs: round(performance.now() - started),
    preflight: { liveness: true, readiness: true, capabilities: true },
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

function operationEligibility(summary) {
  const byOperation = Object.fromEntries(GA_THRESHOLDS.requiredOperations.map((operation) => {
    const row = summary.byOperation[operation];
    const requests = row?.requests ?? 0;
    const failed = row?.failed ?? 0;
    const errorRate = requests === 0 ? 1 : failed / requests;
    const availabilityRate = requests === 0 ? 0 : (requests - failed) / requests;
    const p95Ms = row?.latency?.p95Ms ?? null;
    const p99Ms = row?.latency?.p99Ms ?? null;
    return [operation, {
      requests: { observed: requests, minimum: GA_THRESHOLDS.minimumOperationRequests, passed: requests >= GA_THRESHOLDS.minimumOperationRequests },
      availability: { observed: round(availabilityRate), minimum: GA_THRESHOLDS.minimumAvailabilityRate, passed: availabilityRate >= GA_THRESHOLDS.minimumAvailabilityRate },
      errorRate: { observed: round(errorRate), maximum: GA_THRESHOLDS.maximumErrorRate, passed: errorRate <= GA_THRESHOLDS.maximumErrorRate },
      latencyP95: { observedMs: p95Ms, maximumMs: GA_THRESHOLDS.maximumP95Ms, passed: Number.isFinite(p95Ms) && p95Ms <= GA_THRESHOLDS.maximumP95Ms },
      latencyP99: { observedMs: p99Ms, maximumMs: GA_THRESHOLDS.maximumP99Ms, passed: Number.isFinite(p99Ms) && p99Ms <= GA_THRESHOLDS.maximumP99Ms }
    }];
  }));
  return {
    required: GA_THRESHOLDS.requiredOperations,
    byOperation,
    passed: Object.values(byOperation).every((checks) => Object.values(checks).every((check) => check.passed))
  };
}

function eligibility(config, setup, activeDurationMs, summary, commit, trace, interrupted) {
  const checks = {
    setup: { observed: setup.ok === true, required: true, passed: setup.ok === true },
    commit: { observed: commit.value, passed: commit.value !== "unknown" },
    interruption: { observed: interrupted, passed: interrupted !== true },
    operations: operationEligibility(summary),
    duration: { observedMs: round(activeDurationMs), minimumMs: GA_THRESHOLDS.minimumDurationMs, passed: activeDurationMs >= GA_THRESHOLDS.minimumDurationMs },
    requests: { observed: summary.requests, minimum: GA_THRESHOLDS.minimumRequests, passed: summary.requests >= GA_THRESHOLDS.minimumRequests },
    latencySamples: { observed: summary.latency.observations, minimum: GA_THRESHOLDS.minimumLatencySamples, passed: summary.latency.observations >= GA_THRESHOLDS.minimumLatencySamples },
    availability: { observed: summary.availabilityRate, minimum: GA_THRESHOLDS.minimumAvailabilityRate, passed: summary.availabilityRate >= GA_THRESHOLDS.minimumAvailabilityRate },
    errorRate: { observed: summary.errorRate, maximum: GA_THRESHOLDS.maximumErrorRate, passed: summary.errorRate <= GA_THRESHOLDS.maximumErrorRate },
    latencyP95: { observedMs: summary.latency.p95Ms, maximumMs: GA_THRESHOLDS.maximumP95Ms, passed: Number.isFinite(summary.latency.p95Ms) && summary.latency.p95Ms <= GA_THRESHOLDS.maximumP95Ms },
    latencyP99: { observedMs: summary.latency.p99Ms, maximumMs: GA_THRESHOLDS.maximumP99Ms, passed: Number.isFinite(summary.latency.p99Ms) && summary.latency.p99Ms <= GA_THRESHOLDS.maximumP99Ms },
    trace: {
      path: { observed: trace.path, required: true, passed: typeof trace.path === "string" && trace.path.length > 0 },
      digest: { observed: trace.sha256, required: true, passed: typeof trace.sha256 === "string" && /^sha256:[0-9a-f]{64}$/iu.test(trace.sha256) },
      observedEvents: trace.totalEvents,
      retainedEvents: trace.retainedEvents,
      truncated: trace.truncated,
      writeError: trace.writeError,
      passed: trace.writeError === null && typeof trace.path === "string" && /^sha256:[0-9a-f]{64}$/iu.test(trace.sha256 ?? "")
    }
  };
  const eligibleForGa = Object.values(checks).every((check) => check.passed);
  const sampleType = interrupted ? "interrupted" : activeDurationMs < GA_THRESHOLDS.minimumDurationMs ? "smoke" : "ga-candidate";
  const classification = eligibleForGa ? "ga-eligible" : interrupted ? "interrupted" : sampleType === "smoke" ? "smoke-only" : "ga-candidate-failed";
  const reasons = Object.entries(checks).filter(([, check]) => !check.passed).map(([name]) => name);
  return {
    eligibleForGa,
    sampleType,
    classification,
    reasons,
    checks,
    thresholds: GA_THRESHOLDS,
    note: "Solo una ejecución que cumpla todas las comprobaciones y que sea revisada junto con su entorno y dataset puede usarse como evidencia GA; una prueba corta o interrumpida no es evidencia de disponibilidad."
  };
}

async function writeResult(output, result) {
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function interruptionState(signal, setup) {
  return signal?.aborted === true || setup.error?.kind === "interrupted";
}

function closeActiveOutage(readiness) {
  if (readiness.activeOutage === null) return;
  readiness.state = "not-ready";
  readiness.outages.push(readiness.activeOutage);
  readiness.activeOutage = null;
}

function emptyReadiness() {
  return { state: "unknown", probes: 0, successful: 0, failed: 0, outages: [], activeOutage: null };
}

function traceError(error) {
  return error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
}

function signalController() {
  return new AbortController();
}

function installSignalHandlers(controller) {
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return () => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
}

function finalizeReadiness(readiness) {
  const result = { ...readiness, outages: [...readiness.outages] };
  delete result.activeOutage;
  return result;
}

function resultStatus(result) {
  return result.setup.ok ? "PASS" : "SETUP_FAILED";
}

function rawTraceClaims(trace) {
  return trace.path === null
    ? ["retained raw request and operation events up to the configured limit"]
    : ["complete raw request and operation JSONL trace referenced by its basename and SHA-256 digest"];
}

function benchmarkInterpretation(config, trace) {
  return {
    workload: "HTTP liveness/readiness plus real PREMiSE v2 capability, register, retrieve, query and source-change requests against BASE_URL.",
    availabilityDefinition: "successful semantic logical operations divided by measured operations; HTTP 2xx alone is not sufficient, and readiness requires ready=true.",
    latencyDefinition: "p50/p95/p99 over a bounded uniform reservoir; observations reports the total seen by the runner.",
    rawEvidence: rawTraceClaims(trace),
    livenessPath: config.livenessPath,
    readinessPath: config.healthPath,
    claimsSupported: ["only this run, commit, configuration, target, hardware and retained/raw trace evidence"],
    claimsNotSupported: ["universal capacity", "an SLA or availability guarantee", "external connector quality", "a short-run GA certification"]
  };
}

function outputSummary(result, config) {
  return {
    status: resultStatus(result),
    sampleType: result.eligibility.sampleType,
    classification: result.eligibility.classification,
    eligibleForGa: result.eligibility.eligibleForGa,
    requests: result.metrics.requests,
    availabilityRate: result.metrics.availabilityRate,
    errorRate: result.metrics.errorRate,
    p50Ms: result.metrics.latency.p50Ms,
    p95Ms: result.metrics.latency.p95Ms,
    p99Ms: result.metrics.latency.p99Ms,
    stopReason: result.window.stopReason,
    output: config.output
  };
}

function emptySetup(config, error) {
  return { ok: false, durationMs: 0, preflight: { health: false, capabilities: false }, seedRequested: config.seedCount, seedStored: 0, seedRecords: [], error: { kind: classifyError(error), message: error instanceof Error ? error.message : String(error) } };
}

export async function runSoak(input = {}) {
  const config = normalizeConfig(input);
  const runId = input.runId ?? randomUUID();
  const environment = String(process.env.PREMISE_ENV ?? "development").trim().toLowerCase();
  const signer = await loadSignedEnvelopeClient({ required: environment === "production" || environment === "staging" || process.env.PREMISE_REQUIRE_SIGNED_ENVELOPES === "1" });
  const abortSignal = input.abortSignal ?? input.signal;
  config.abortSignal = abortSignal;
  const trace = new TraceWriter({ output: config.traceOutput, limit: config.rawTraceLimit, runId });
  try {
    await trace.open();
  } catch (error) {
    trace.writeError = traceError(error);
  }
  config.traceWriter = trace;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let setup;
  try {
    setup = await setupTarget(config, runId, signer);
  } catch (error) {
    setup = emptySetup(config, error);
  }

  const metrics = makeMetrics(config);
  const state = { runId, signer, seedRecords: setup.seedRecords, nextSequence: 0, readiness: emptyReadiness(), trace };
  const measuredWindow = input.measuredWindow;
  let measuredStarted = false;
  let measuredStart = performance.now();
  try {
    if (setup.ok && abortSignal?.aborted !== true) {
      if (typeof measuredWindow?.start === "function") await measuredWindow.start({ runId });
      measuredStarted = true;
      measuredStart = performance.now();
      const deadline = measuredStart + config.durationMs;
      const worker = async () => {
        while (abortSignal?.aborted !== true && performance.now() < deadline) {
          const sequence = state.nextSequence;
          state.nextSequence += 1;
          const operation = config.operations[sequence % config.operations.length];
          await measure(config, state, metrics, operation, sequence);
        }
      };
      await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
    }
  } finally {
    if (measuredStarted && typeof measuredWindow?.end === "function") await measuredWindow.end({ runId });
  }
  const ended = performance.now();
  closeActiveOutage(state.readiness);
  try {
    await trace.close();
  } catch (error) {
    trace.writeError ??= traceError(error);
  }
  const endedAt = new Date().toISOString();
  const summary = { ...summarizeMetrics(metrics), readiness: finalizeReadiness(state.readiness) };
  const commit = commitMetadata();
  const hardware = hardwareMetadata();
  const traceSummary = trace.summary();
  const activeDurationMs = measuredStarted ? ended - measuredStart : 0;
  const interrupted = interruptionState(abortSignal, setup);
  const window = {
    configuredDurationMs: config.durationMs,
    activeDurationMs: round(activeDurationMs),
    wallClockDurationMs: round(ended - started),
    deadlineReached: measuredStarted && activeDurationMs >= config.durationMs,
    inFlightTailMs: round(Math.max(0, activeDurationMs - config.durationMs)),
    stopReason: interrupted ? "interrupted" : measuredStarted && activeDurationMs >= config.durationMs ? "deadline" : "setup-failed"
  };
  const result = {
    schema: FORMAT,
    format: FORMAT,
    benchmark: "ga-soak",
    runId,
    generatedAt: endedAt,
    source: { kind: "live-http", baseUrl: config.baseUrl, healthPath: config.healthPath, livenessPath: config.livenessPath },
    trace: traceSummary,
    startedAt,
    endedAt,
    commit: commit.value,
    commitSource: commit.source,
    runtime: { node: process.version, versions: { ...process.versions } },
    hardware,
    target: { baseUrl: config.baseUrl, tenantId: config.tenantId, healthPath: config.healthPath, livenessPath: config.livenessPath, authorizationConfigured: typeof process.env.PREMISE_API_TOKEN === "string" && process.env.PREMISE_API_TOKEN.length > 0 },
    configuration: {
      durationMs: config.durationMs,
      concurrency: config.concurrency,
      requestTimeoutMs: config.requestTimeoutMs,
      seedCount: config.seedCount,
      maxResponseBytes: config.maxResponseBytes,
      latencySampleSize: config.latencySampleSize,
      rawTraceLimit: config.rawTraceLimit,
      traceOutput: traceSummary.path,
      operations: config.operations,
      signing: { required: signer !== undefined || environment === "production" || environment === "staging" || process.env.PREMISE_REQUIRE_SIGNED_ENVELOPES === "1", configured: signer !== undefined, keyId: signer?.keyId ?? null }
    },
    setup: { ...setup, seedRecords: setup.seedRecords.map(({ memoryId, sourceUri }) => ({ memoryId, sourceUri })) },
    window,
    metrics: summary,
    eligibility: eligibility(config, setup, activeDurationMs, summary, commit, traceSummary, interrupted),
    interpretation: benchmarkInterpretation(config, traceSummary)
  };
  if (config.output !== undefined) await writeResult(config.output, result);
  return result;
}

async function main() {
  const parsed = parseArgs();
  if (parsed.help) {
    console.log(help());
    return;
  }
  const controller = signalController();
  const removeSignalHandlers = installSignalHandlers(controller);
  let result;
  try {
    result = await runSoak({ ...parsed.config, abortSignal: controller.signal });
  } finally {
    removeSignalHandlers();
  }
  console.log(JSON.stringify(outputSummary(result, parsed.config), null, 2));
  if (parsed.config.enforceGa && !result.eligibility.eligibleForGa) process.exitCode = 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
