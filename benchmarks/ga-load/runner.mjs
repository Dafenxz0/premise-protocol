import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { availableParallelism, arch, platform, tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FORMAT = "ga-reliability-benchmark/1";
const EVENT_FORMAT = "ga-memory-event/1";
const SNAPSHOT_FORMAT = "ga-memory-snapshot/1";
const FIXED_TIME = "2026-08-10T00:00:00.000Z";
const OUTPUT = fileURLToPath(new URL("./results.json", import.meta.url));
const WORKER = new URL("./worker.mjs", import.meta.url);
const NODE_REQUIRED = 24;

const PROFILE_DEFAULTS = Object.freeze({
  small: Object.freeze({ memories: 10_000, tenants: 4, concurrency: 2, batchSize: 256, reliabilityMemories: 2_048, maxMs: 120_000 }),
  ci: Object.freeze({ memories: 100_000, tenants: 16, concurrency: 4, batchSize: 512, reliabilityMemories: 10_000, maxMs: 600_000 }),
  full: Object.freeze({ memories: 1_000_000, tenants: 64, concurrency: 8, batchSize: 1_024, reliabilityMemories: 50_000, maxMs: 1_800_000 })
});

const PERFORMANCE_GATE = Object.freeze({
  minMemoriesPerSecond: 10_000,
  maxBatchP99Ms: 500,
  maxPeakHeapBytes: 1_024 * 1024 * 1024
});

class JournalCorruptionError extends Error {
  constructor(line, message) {
    super(`journal line ${line}: ${message}`);
    this.name = "JournalCorruptionError";
    this.line = line;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function round(value) {
  return Number(value.toFixed(3));
}

function mix32(value) {
  value >>>= 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function hex32(value) {
  return (value >>> 0).toString(16).padStart(8, "0");
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]);
}

function latencySummary(values) {
  return {
    sampleUnit: "batch",
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99)
  };
}

function heapSample() {
  const usage = process.memoryUsage();
  return {
    heapUsedBytes: usage.heapUsed,
    rssBytes: usage.rss,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers
  };
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive safe integer`);
  return parsed;
}

function parseSeed(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("--seed must be a non-negative safe integer");
  return parsed >>> 0;
}

function argumentValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node benchmarks/ga-load/runner.mjs [options]

Profiles: small (10k), ci (100k), full (1M synthetic memories).
Options:
  --profile small|ci|full     workload preset (default: small)
  --scenario all|load|reliability
  --memories N                override load memory count
  --tenants N                 tenant count
  --concurrency N             worker threads and max in-flight batches
  --batch-size N              memories generated per worker message
  --reliability-memories N   size of journal/snapshot scenarios
  --seed N                    deterministic unsigned seed
  --max-ms N                  per-phase deadline
  --output PATH               result JSON path
  --enforce-gates             exit non-zero when Node/performance gates fail
  --help`);
}

function parseArgs(argv) {
  let profile = "small";
  let scenario = "all";
  let output = OUTPUT;
  const overrides = {};
  let seed = 20260810;
  let enforceGates = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inlineValue] = argument.split("=", 2);
    if (flag === "--help" || flag === "-h") {
      help = true;
      continue;
    }
    if (flag === "--enforce-gates") {
      enforceGates = true;
      continue;
    }
    if (flag === "--profile") {
      profile = inlineValue ?? argumentValue(argv, index, flag);
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (flag === "--scenario") {
      scenario = inlineValue ?? argumentValue(argv, index, flag);
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (flag === "--output") {
      output = path.resolve(process.cwd(), inlineValue ?? argumentValue(argv, index, flag));
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (flag === "--seed") {
      seed = parseSeed(inlineValue ?? argumentValue(argv, index, flag));
      if (inlineValue === undefined) index += 1;
      continue;
    }
    const numericFlags = new Map([
      ["--memories", "memories"],
      ["--tenants", "tenants"],
      ["--concurrency", "concurrency"],
      ["--batch-size", "batchSize"],
      ["--reliability-memories", "reliabilityMemories"],
      ["--max-ms", "maxMs"]
    ]);
    const property = numericFlags.get(flag);
    if (property) {
      const value = inlineValue ?? argumentValue(argv, index, flag);
      if (inlineValue === undefined) index += 1;
      overrides[property] = parsePositiveInteger(value, flag);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (help) return { help: true };
  if (!Object.hasOwn(PROFILE_DEFAULTS, profile)) throw new Error(`--profile must be one of: ${Object.keys(PROFILE_DEFAULTS).join(", ")}`);
  if (!["all", "load", "reliability"].includes(scenario)) throw new Error("--scenario must be all, load or reliability");
  const defaults = PROFILE_DEFAULTS[profile];
  const config = { ...defaults, ...overrides, profile, scenario, seed, output, enforceGates };
  config.reliabilityMemories = Math.min(config.memories, config.reliabilityMemories);
  if (config.tenants > config.memories) throw new Error("--tenants cannot exceed --memories");
  return config;
}

function deadlineFor(config) {
  return performance.now() + config.maxMs;
}

function checkDeadline(deadline, label) {
  if (performance.now() > deadline) throw new Error(`${label} exceeded --max-ms`);
}

function tenantIdFor(tenantIndex) {
  return `tenant:${tenantIndex}`;
}

function memoryIdFor(tenantIndex, index) {
  return `memory:${tenantIndex}:${index.toString(36)}`;
}

function tupleFor(index, tenantCount, seed) {
  return [index % tenantCount, index, mix32(seed + index)];
}

function eventForTuple(tuple, seed) {
  const [tenantIndex, index, valueHash] = tuple;
  const tenantId = tenantIdFor(tenantIndex);
  const memoryId = memoryIdFor(tenantIndex, index);
  return {
    format: EVENT_FORMAT,
    seq: index,
    tenantId,
    memoryId,
    idempotencyKey: `put:${tenantId}:${index}`,
    requestDigest: `sha256:${hex32(mix32(seed ^ index ^ 0x9e3779b9))}`,
    contentDigest: `sha256:${hex32(valueHash)}`,
    occurredAt: FIXED_TIME,
    payload: { version: 1, valueHash }
  };
}

function validateEvent(event) {
  if (!event || typeof event !== "object") throw new Error("event must be an object");
  for (const field of ["format", "tenantId", "memoryId", "idempotencyKey", "requestDigest", "contentDigest", "occurredAt"]) {
    if (typeof event[field] !== "string" || event[field].length === 0) throw new Error(`event.${field} must be a non-empty string`);
  }
  if (event.format !== EVENT_FORMAT) throw new Error(`unsupported event format: ${event.format}`);
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw new Error("event.seq must be a non-negative safe integer");
  if (!event.payload || typeof event.payload !== "object" || !Number.isSafeInteger(event.payload.valueHash)) throw new Error("event.payload.valueHash is required");
}

class SyntheticMemoryStore {
  constructor({ trackIdempotency = false } = {}) {
    this.recordsByTenant = new Map();
    this.eventDigests = trackIdempotency ? new Map() : undefined;
  }

  apply(event) {
    validateEvent(event);
    const previousDigest = this.eventDigests?.get(event.idempotencyKey);
    if (previousDigest !== undefined) {
      if (previousDigest !== event.requestDigest) throw new Error(`idempotency conflict: ${event.idempotencyKey}`);
      return "duplicate";
    }

    const tenantRecords = this.recordsByTenant.get(event.tenantId) ?? new Map();
    const existing = tenantRecords.get(event.memoryId);
    if (existing !== undefined) {
      if (existing.contentDigest === event.contentDigest) return "duplicate";
      throw new Error(`memory conflict: ${event.tenantId}/${event.memoryId}`);
    }

    tenantRecords.set(event.memoryId, {
      tenantId: event.tenantId,
      memoryId: event.memoryId,
      seq: event.seq,
      contentDigest: event.contentDigest,
      valueHash: event.payload.valueHash
    });
    this.recordsByTenant.set(event.tenantId, tenantRecords);
    this.eventDigests?.set(event.idempotencyKey, event.requestDigest);
    return "applied";
  }

  get(tenantId, memoryId) {
    return this.recordsByTenant.get(tenantId)?.get(memoryId);
  }

  count(tenantId) {
    if (tenantId !== undefined) return this.recordsByTenant.get(tenantId)?.size ?? 0;
    let total = 0;
    for (const records of this.recordsByTenant.values()) total += records.size;
    return total;
  }

  snapshot(capturedAt) {
    const records = [];
    for (const tenantRecords of this.recordsByTenant.values()) for (const record of tenantRecords.values()) records.push(record);
    return {
      format: SNAPSHOT_FORMAT,
      version: 1,
      capturedAt,
      records,
      eventKeys: this.eventDigests ? [...this.eventDigests.entries()] : []
    };
  }

  restore(snapshot) {
    if (snapshot?.format !== SNAPSHOT_FORMAT || snapshot.version !== 1 || !Array.isArray(snapshot.records)) throw new Error("unsupported synthetic snapshot");
    this.recordsByTenant.clear();
    this.eventDigests?.clear();
    for (const record of snapshot.records) {
      if (!record || typeof record.tenantId !== "string" || typeof record.memoryId !== "string") throw new Error("invalid snapshot record");
      const tenantRecords = this.recordsByTenant.get(record.tenantId) ?? new Map();
      tenantRecords.set(record.memoryId, record);
      this.recordsByTenant.set(record.tenantId, tenantRecords);
    }
    if (this.eventDigests) for (const [key, digest] of snapshot.eventKeys ?? []) this.eventDigests.set(key, digest);
  }
}

class JournalWriter {
  constructor(filename) {
    this.stream = createWriteStream(filename, { encoding: "utf8", highWaterMark: 16 * 1024 });
    this.writes = 0;
    this.bytes = 0;
    this.backpressureEvents = 0;
    this.backpressureWaitMs = 0;
    this.closed = false;
  }

  async append(chunk) {
    this.writes += 1;
    this.bytes += Buffer.byteLength(chunk);
    if (this.stream.write(chunk)) return;
    this.backpressureEvents += 1;
    const started = performance.now();
    await new Promise((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.stream.off("drain", onDrain);
        this.stream.off("error", onError);
      };
      this.stream.once("drain", onDrain);
      this.stream.once("error", onError);
    });
    this.backpressureWaitMs += performance.now() - started;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await new Promise((resolve, reject) => {
      const onClose = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.stream.off("close", onClose);
        this.stream.off("error", onError);
      };
      this.stream.once("close", onClose);
      this.stream.once("error", onError);
      this.stream.end();
    });
  }
}

function createWorkerClient(onError) {
  const worker = new Worker(WORKER);
  let pending;
  let terminated = false;
  const request = (payload) => new Promise((resolve, reject) => {
    if (terminated) {
      reject(new Error("worker is terminated"));
      return;
    }
    if (pending !== undefined) {
      reject(new Error("worker received concurrent requests"));
      return;
    }
    pending = { resolve, reject };
    try {
      worker.postMessage(payload);
    } catch (error) {
      pending = undefined;
      reject(error);
      onError(error);
    }
  });
  worker.on("message", (message) => {
    const current = pending;
    pending = undefined;
    if (current === undefined) return;
    if (message.error) current.reject(Object.assign(new Error(message.error.message), { name: message.error.name, source: "worker" }));
    else current.resolve(message);
  });
  worker.on("error", (error) => {
    onError(Object.assign(error, { source: "worker" }));
    pending?.reject(error);
    pending = undefined;
  });
  worker.on("exit", (code) => {
    if (code !== 0 && !terminated) {
      const error = Object.assign(new Error(`worker exited with code ${code}`), { source: "worker" });
      onError(error);
      pending?.reject(error);
      pending = undefined;
    }
  });
  return {
    request,
    async terminate() {
      terminated = true;
      await worker.terminate();
    }
  };
}

async function runLoad(config, tempRoot) {
  const journalPath = path.join(tempRoot, "load.ndjson");
  const writer = new JournalWriter(journalPath);
  const store = new SyntheticMemoryStore();
  const latencies = [];
  const errors = { unexpected: 0, worker: 0, journal: 0, store: 0 };
  const beforeHeap = heapSample();
  let peakHeap = beforeHeap;
  const deadline = deadlineFor(config);
  const batchCount = Math.ceil(config.memories / config.batchSize);
  let nextJob = 0;
  let nextCommit = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let fatalError;
  const ready = new Map();
  const waiters = new Map();
  let flushTail = Promise.resolve();

  const fail = (error) => {
    if (fatalError !== undefined) return;
    fatalError = error;
    if (error?.source === "worker") errors.worker += 1;
    else if (error?.source === "journal" || error?.code === "ERR_STREAM_WRITE_AFTER_END" || error?.code === "EPIPE") errors.journal += 1;
    else if (error?.source === "store") errors.store += 1;
    else errors.unexpected += 1;
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
  };

  const commit = async (response) => {
    checkDeadline(deadline, "load");
    const events = response.records.map((tuple) => eventForTuple(tuple, config.seed));
    const chunk = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    try {
      await writer.append(chunk);
    } catch (error) {
      throw Object.assign(error, { source: "journal" });
    }
    try {
      for (const event of events) store.apply(event);
    } catch (error) {
      throw Object.assign(error, { source: "store" });
    }
    latencies.push(performance.now() - response.sentAt);
    inFlight -= 1;
    const currentHeap = heapSample();
    if (currentHeap.heapUsedBytes > peakHeap.heapUsedBytes) peakHeap = currentHeap;
  };

  const flushReady = async () => {
    while (ready.has(nextCommit)) {
      const response = ready.get(nextCommit);
      ready.delete(nextCommit);
      const waiter = waiters.get(nextCommit);
      try {
        await commit(response);
        nextCommit += 1;
        waiter?.resolve();
      } catch (error) {
        waiter?.reject(error);
        throw error;
      } finally {
        waiters.delete(response.id);
      }
    }
  };

  const scheduleFlush = () => {
    const task = flushTail.then(flushReady);
    flushTail = task.catch((error) => {
      fail(error);
    });
    return task;
  };

  const submit = (response) => {
    if (fatalError !== undefined) return Promise.reject(fatalError);
    ready.set(response.id, response);
    const committed = new Promise((resolve, reject) => waiters.set(response.id, { resolve, reject }));
    void scheduleFlush();
    return committed;
  };

  const clients = Array.from({ length: config.concurrency }, () => createWorkerClient(fail));
  const loops = clients.map(async (client) => {
    while (true) {
      if (fatalError !== undefined) throw fatalError;
      const id = nextJob;
      nextJob += 1;
      const start = id * config.batchSize;
      if (start >= config.memories) return;
      const count = Math.min(config.batchSize, config.memories - start);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const sentAt = performance.now();
      const response = await client.request({ id, start, count, tenantCount: config.tenants, seed: config.seed });
      response.sentAt = sentAt;
      await submit(response);
    }
  });

  const started = performance.now();
  try {
    await Promise.all(loops);
    await flushTail;
    if (fatalError !== undefined) throw fatalError;
    assert(nextCommit === batchCount, `committed ${nextCommit} of ${batchCount} batches`);
  } catch (error) {
    fail(error);
    throw error;
  } finally {
    await Promise.all(clients.map((client) => client.terminate().catch(() => undefined)));
    await writer.close().catch((error) => {
      errors.journal += 1;
      if (fatalError === undefined) fatalError = error;
    });
  }
  if (fatalError !== undefined) throw fatalError;

  const durationMs = performance.now() - started;
  const afterHeap = heapSample();
  if (afterHeap.heapUsedBytes > peakHeap.heapUsedBytes) peakHeap = afterHeap;
  const tenantCounts = Object.fromEntries(Array.from({ length: config.tenants }, (_, tenantIndex) => {
    const tenantId = tenantIdFor(tenantIndex);
    return [tenantId, store.count(tenantId)];
  }));
  const crossTenantRecord = config.tenants === 1 ? undefined : store.get(tenantIdFor(0), memoryIdFor(1, 1));
  const isolation = {
    passed: store.get(tenantIdFor(0), memoryIdFor(0, 0)) !== undefined &&
      crossTenantRecord === undefined &&
      (config.tenants === 1 || store.get(tenantIdFor(1), memoryIdFor(1, 1)) !== undefined),
    crossTenantRead: "rejected"
  };
  return {
    memoriesRequested: config.memories,
    memoriesApplied: store.count(),
    batches: batchCount,
    batchSize: config.batchSize,
    concurrency: config.concurrency,
    workerThreads: config.concurrency,
    durationMs: round(durationMs),
    throughput: {
      memoriesPerSecond: round(config.memories / Math.max(durationMs / 1000, 0.000001)),
      batchesPerSecond: round(batchCount / Math.max(durationMs / 1000, 0.000001))
    },
    latency: latencySummary(latencies),
    heap: {
      sampling: "parent process only",
      beforeBytes: beforeHeap.heapUsedBytes,
      afterBytes: afterHeap.heapUsedBytes,
      peakBytes: peakHeap.heapUsedBytes,
      deltaBytes: afterHeap.heapUsedBytes - beforeHeap.heapUsedBytes,
      peakRssBytes: peakHeap.rssBytes
    },
    journal: {
      format: "NDJSON",
      bytes: writer.bytes,
      writes: writer.writes,
      orderedBy: "synthetic sequence; batches commit in ascending id"
    },
    backpressure: {
      configuredConcurrency: config.concurrency,
      maxInFlightBatches: maxInFlight,
      writeBackpressureEvents: writer.backpressureEvents,
      writeBackpressureWaitMs: round(writer.backpressureWaitMs),
      sampleUnit: "journal batch"
    },
    errors,
    tenants: { count: config.tenants, records: tenantCounts, total: store.count() },
    isolation,
    deterministic: true
  };
}

function eventLines(events) {
  return events.map((event) => JSON.stringify(event));
}

function eventText(events) {
  return `${eventLines(events).join("\n")}\n`;
}

async function writeJournal(filename, events, { trailingNewline = true } = {}) {
  const lines = eventLines(events);
  await writeFile(filename, `${lines.join("\n")}${trailingNewline ? "\n" : ""}`, "utf8");
}

async function replayJournal(filename, store, { allowTruncatedTail = false } = {}) {
  const text = await readFile(filename, "utf8");
  let lines = text.split("\n");
  let ignoredTailLines = 0;
  if (lines.at(-1) === "") lines = lines.slice(0, -1);
  else if (allowTruncatedTail) {
    lines = lines.slice(0, -1);
    ignoredTailLines = 1;
  } else {
    throw new JournalCorruptionError(lines.length, "journal does not end with a complete line");
  }
  let applied = 0;
  let duplicates = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
      validateEvent(event);
    } catch (error) {
      throw new JournalCorruptionError(index + 1, error.message);
    }
    try {
      const outcome = store.apply(event);
      if (outcome === "duplicate") duplicates += 1;
      else applied += 1;
    } catch (error) {
      throw new JournalCorruptionError(index + 1, error.message);
    }
  }
  return { applied, duplicates, lines: lines.length, ignoredTailLines };
}

function reliabilityEvents(config, count) {
  return Array.from({ length: count }, (_, index) => eventForTuple(tupleFor(index, config.tenants, config.seed), config.seed));
}

async function timedScenario(name, operation) {
  const started = performance.now();
  try {
    const result = await operation();
    return { name, durationMs: round(performance.now() - started), ...result };
  } catch (error) {
    return { name, durationMs: round(performance.now() - started), passed: false, unexpectedError: error.message };
  }
}

async function crashRestartScenario(events, tempRoot) {
  return timedScenario("crash-restart", async () => {
    const cut = Math.max(1, Math.floor(events.length * 0.6));
    const filename = path.join(tempRoot, "crash-restart.ndjson");
    await writeJournal(filename, events.slice(0, cut));
    const beforeRestart = new SyntheticMemoryStore({ trackIdempotency: true });
    const prefixReplay = await replayJournal(filename, beforeRestart);
    await appendFile(filename, eventText(events.slice(cut)), "utf8");
    const afterRestart = new SyntheticMemoryStore({ trackIdempotency: true });
    const fullReplay = await replayJournal(filename, afterRestart);
    const replayAgain = await replayJournal(filename, afterRestart);
    return {
      passed: prefixReplay.applied === cut && fullReplay.applied === events.length && replayAgain.duplicates === events.length && afterRestart.count() === events.length,
      expectedPrefix: cut,
      prefixApplied: prefixReplay.applied,
      fullApplied: fullReplay.applied,
      replayDuplicates: replayAgain.duplicates,
      recoveredMemories: afterRestart.count()
    };
  });
}

async function duplicateEventsScenario(events, tempRoot) {
  return timedScenario("duplicate-events", async () => {
    const duplicateCount = Math.min(events.length, Math.max(8, Math.floor(events.length / 3)));
    const filename = path.join(tempRoot, "duplicate-events.ndjson");
    await writeJournal(filename, [...events, ...events.slice(0, duplicateCount)]);
    const store = new SyntheticMemoryStore({ trackIdempotency: true });
    const replay = await replayJournal(filename, store);
    const conflicting = { ...events[0], requestDigest: "sha256:conflict", contentDigest: "sha256:conflict" };
    let conflictRejected = false;
    try {
      store.apply(conflicting);
    } catch {
      conflictRejected = true;
    }
    return {
      passed: replay.applied === events.length && replay.duplicates === duplicateCount && store.count() === events.length && conflictRejected,
      uniqueEvents: events.length,
      duplicateEvents: duplicateCount,
      applied: replay.applied,
      ignoredDuplicates: replay.duplicates,
      conflictingIdempotencyRejected: conflictRejected
    };
  });
}

async function journalDamageScenario(events, tempRoot) {
  return timedScenario("journal-corruption-truncation", async () => {
    const lines = eventLines(events);
    const truncatedFile = path.join(tempRoot, "truncated.ndjson");
    const partialTail = lines.at(-1).slice(0, -Math.min(5, Math.max(1, lines.at(-1).length - 1)));
    await writeFile(truncatedFile, `${lines.slice(0, -1).join("\n")}\n${partialTail}`, "utf8");
    const truncatedStore = new SyntheticMemoryStore({ trackIdempotency: true });
    const truncated = await replayJournal(truncatedFile, truncatedStore, { allowTruncatedTail: true });

    const corruptIndex = Math.floor(events.length / 2);
    const corruptFile = path.join(tempRoot, "corrupt-middle.ndjson");
    const corruptLines = [...lines];
    corruptLines[corruptIndex] = "{\"format\":\"ga-memory-event/1\",\"corrupt\":";
    await writeFile(corruptFile, `${corruptLines.join("\n")}\n`, "utf8");
    const corruptStore = new SyntheticMemoryStore({ trackIdempotency: true });
    let corruptionRejected = false;
    let corruptionLine;
    try {
      await replayJournal(corruptFile, corruptStore);
    } catch (error) {
      corruptionRejected = error instanceof JournalCorruptionError;
      corruptionLine = error.line;
    }
    return {
      passed: truncated.applied === events.length - 1 && truncated.ignoredTailLines === 1 && corruptionRejected && corruptionLine === corruptIndex + 1 && corruptStore.count() === corruptIndex,
      truncatedApplied: truncated.applied,
      truncatedTailIgnored: truncated.ignoredTailLines,
      corruptPrefixApplied: corruptStore.count(),
      corruptLine: corruptionLine,
      corruptionRejected
    };
  });
}

async function snapshotRecoveryScenario(events, tempRoot) {
  return timedScenario("snapshot-recovery", async () => {
    const cut = Math.max(1, Math.floor(events.length / 2));
    const snapshotSource = new SyntheticMemoryStore({ trackIdempotency: true });
    for (const event of events.slice(0, cut)) snapshotSource.apply(event);
    const snapshotFile = path.join(tempRoot, "recovery.snapshot.json");
    await writeFile(snapshotFile, `${JSON.stringify(snapshotSource.snapshot(FIXED_TIME))}\n`, "utf8");
    const restored = new SyntheticMemoryStore({ trackIdempotency: true });
    restored.restore(JSON.parse(await readFile(snapshotFile, "utf8")));
    const tailFile = path.join(tempRoot, "recovery-tail.ndjson");
    await writeJournal(tailFile, events.slice(cut));
    const tailReplay = await replayJournal(tailFile, restored);
    return {
      passed: restored.count() === events.length && snapshotSource.count() === cut && tailReplay.applied === events.length - cut,
      snapshotMemories: snapshotSource.count(),
      tailApplied: tailReplay.applied,
      recoveredMemories: restored.count(),
      snapshotFormat: SNAPSHOT_FORMAT
    };
  });
}

async function tenantIsolationScenario(config) {
  return timedScenario("tenant-isolation", async () => {
    const store = new SyntheticMemoryStore({ trackIdempotency: true });
    const first = eventForTuple([0, 0, mix32(config.seed)], config.seed);
    const second = { ...eventForTuple([1, 1, mix32(config.seed + 1)], config.seed), memoryId: "memory:shared" };
    const sameLocalId = { ...first, memoryId: "memory:shared", idempotencyKey: "put:tenant:0:shared" };
    store.apply(sameLocalId);
    store.apply(second);
    const ownFirst = store.get("tenant:0", "memory:shared");
    const ownSecond = store.get("tenant:1", "memory:shared");
    const foreign = store.get("tenant:0", memoryIdFor(1, 1));
    return {
      passed: ownFirst?.tenantId === "tenant:0" && ownSecond?.tenantId === "tenant:1" && foreign === undefined,
      tenantZeroRecords: store.count("tenant:0"),
      tenantOneRecords: store.count("tenant:1"),
      foreignRead: foreign === undefined ? "rejected" : "leaked"
    };
  });
}

async function runReliability(config, tempRoot) {
  const events = reliabilityEvents(config, config.reliabilityMemories);
  const scenarios = [
    await crashRestartScenario(events, tempRoot),
    await duplicateEventsScenario(events, tempRoot),
    await journalDamageScenario(events, tempRoot),
    await snapshotRecoveryScenario(events, tempRoot),
    await tenantIsolationScenario(config)
  ];
  const failed = scenarios.filter((scenario) => !scenario.passed);
  return {
    memories: events.length,
    tenants: config.tenants,
    scenarios,
    passed: failed.length === 0,
    errors: { unexpected: failed.length, expected: 2, expectedKinds: ["duplicate idempotency conflict", "corrupt middle journal"] }
  };
}

function buildGates(config, nodeInfo, load, reliability) {
  const checks = {};
  if (load !== undefined) {
    checks.loadCount = load.memoriesApplied === load.memoriesRequested;
    checks.loadErrors = load.errors.unexpected === 0 && load.errors.worker === 0 && load.errors.journal === 0 && load.errors.store === 0;
    checks.loadTenantIsolation = load.isolation.passed === true;
    checks.loadBackpressureBounded = load.backpressure.maxInFlightBatches <= config.concurrency;
  }
  if (reliability !== undefined) checks.reliabilityScenarios = reliability.passed === true && reliability.errors.unexpected === 0;
  const correctness = { passed: Object.values(checks).every(Boolean), checks };
  const performanceEvaluated = config.profile === "ci" && load !== undefined && nodeInfo.major === NODE_REQUIRED;
  const performance = {
    evaluated: performanceEvaluated,
    thresholds: PERFORMANCE_GATE,
    observed: load === undefined ? undefined : {
      memoriesPerSecond: load.throughput.memoriesPerSecond,
      batchP99Ms: load.latency.p99Ms,
      peakHeapBytes: load.heap.peakBytes
    },
    passed: !performanceEvaluated || (load.throughput.memoriesPerSecond >= PERFORMANCE_GATE.minMemoriesPerSecond && load.latency.p99Ms <= PERFORMANCE_GATE.maxBatchP99Ms && load.heap.peakBytes <= PERFORMANCE_GATE.maxPeakHeapBytes)
  };
  const node24 = { requiredMajor: NODE_REQUIRED, actualMajor: nodeInfo.major, passed: nodeInfo.major === NODE_REQUIRED, smokeOnly: nodeInfo.major !== NODE_REQUIRED };
  return {
    node24,
    correctness,
    performance,
    allPassed: node24.passed && correctness.passed && performance.passed
  };
}

export async function run(options = parseArgs(process.argv.slice(2))) {
  if (options.help) {
    printHelp();
    return undefined;
  }
  const nodeInfo = {
    version: process.version,
    major: Number(process.versions.node.split(".")[0]),
    platform: platform(),
    arch: arch(),
    availableParallelism: availableParallelism()
  };
  const tempRoot = await mkdtemp(path.join(tmpdir(), "ga-load-"));
  let load;
  let reliability;
  try {
    if (options.scenario === "all" || options.scenario === "load") load = await runLoad(options, tempRoot);
    if (options.scenario === "all" || options.scenario === "reliability") reliability = await runReliability(options, tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  const gates = buildGates(options, nodeInfo, load, reliability);
  const result = {
    format: FORMAT,
    generatedAt: new Date().toISOString(),
    runner: "node-worker-threads",
    node: nodeInfo,
    profile: options.profile,
    scenario: options.scenario,
    seed: options.seed,
    deterministicWorkload: true,
    configuration: {
      memories: options.memories,
      tenants: options.tenants,
      concurrency: options.concurrency,
      batchSize: options.batchSize,
      reliabilityMemories: options.reliabilityMemories,
      maxMs: options.maxMs,
      enforceGates: options.enforceGates
    },
    load: load ?? { skipped: true },
    reliability: reliability ?? { skipped: true },
    gates,
    interpretation: {
      universalCapacityClaim: false,
      statement: "Synthetic workload measurements for this host and configuration; not an SLA, production capacity promise, or universal capability.",
      latencySampleUnit: "journal batch end-to-end from worker dispatch through ordered journal write and store apply",
      heapScope: "parent process; worker heaps are not included",
      payloadScope: "metadata-only synthetic records; no external retrieval, network, or production database"
    }
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    format: result.format,
    profile: result.profile,
    node: result.node.version,
    load: result.load.skipped ? "skipped" : { memories: result.load.memoriesApplied, throughput: result.load.throughput.memoriesPerSecond, latency: result.load.latency, heapPeakBytes: result.load.heap.peakBytes },
    reliability: result.reliability.skipped ? "skipped" : { memories: result.reliability.memories, passed: result.reliability.passed },
    gates: result.gates
  }, null, 2));
  if (options.enforceGates && !gates.allPassed) throw new Error("GA reliability gates failed; inspect results.json");
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch((error) => {
    console.error(`ga-load failed: ${error.message}`);
    process.exitCode = 1;
  });
}
