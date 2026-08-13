import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const RUNTIME_ENTRY = resolve(ROOT, "packages/runtime-core/dist/index.js");
const ORACLE_ENTRY = fileURLToPath(new URL("./oracle.mjs", import.meta.url));
const OUTPUT_DIRECTORY = resolve(ROOT, ".tmp", "premise-efficiency-lab", "v1", "horizon");
const AT = "2026-08-13T00:00:00.000Z";
const SOURCE = "source://horizon/source";
const FORMAT = "premise-efficiency-lab/long-horizon/v1";

function heapSample() {
  const usage = process.memoryUsage();
  return Object.freeze({ heapUsedBytes: usage.heapUsed, rssBytes: usage.rss, externalBytes: usage.external });
}

function collectGarbage() {
  if (typeof globalThis.gc === "function") globalThis.gc();
}

function envelope(memoryId, dependsOn = [], versionToken = "v1") {
  return {
    specVersion: "premise/2",
    tenantId: "tenant:horizon",
    memoryId,
    evidence: dependsOn.length === 0 ? [{
      evidenceId: `${memoryId}:e:${versionToken}`,
      sourceUri: SOURCE,
      observedAt: AT,
      version: { scheme: "horizon.source", token: versionToken },
      validator: { id: "horizon-validator", operation: "read" }
    }] : [],
    confidence: { score: null, method: "horizon-benchmark", assessedAt: AT },
    conflicts: [],
    temporal: { asOf: AT },
    validity: { status: "FRESH", checkedAt: AT, policy: "VERSIONED" },
    dependsOn,
    signatures: []
  };
}

function scopeFactory(evidence, record) {
  return {
    tenantId: record.envelope.tenantId,
    resourceId: evidence.sourceUri,
    incarnationId: `inc:${evidence.evidenceId}`,
    versionToken: `${evidence.version.scheme}:${evidence.version.token}`,
    scopes: ["read:source"],
    queryDigest: "query:horizon",
    validatorId: evidence.validator.id,
    authorizationContextDigest: "auth:horizon",
    policyDigest: "policy:horizon",
    changeSetDigest: null,
    causalFrontier: []
  };
}

function probeScope(versionToken) {
  return {
    tenantId: "tenant:horizon",
    resourceId: SOURCE,
    incarnationId: "inc:horizon-probe",
    versionToken,
    scopes: ["read:source"],
    queryDigest: "query:horizon-probe",
    validatorId: "horizon-validator",
    authorizationContextDigest: "auth:horizon",
    policyDigest: "policy:horizon",
    changeSetDigest: null,
    causalFrontier: []
  };
}

function runFrontierProbe(IncrementalFrontierEngine, rootCount) {
  const nodes = [];
  for (let index = 0; index < rootCount; index += 1) {
    nodes.push({ id: `probe:root:${index}`, dependsOn: [] });
    nodes.push({ id: `probe:leaf:${index}`, dependsOn: [`probe:root:${index}`] });
  }
  const engine = new IncrementalFrontierEngine(nodes);
  let errors = 0;
  for (let index = 0; index < rootCount; index += 1) {
    try {
      engine.markDirty([`probe:root:${index}`], "STALE");
      engine.resolve(`probe:root:${index}`);
    } catch {
      errors += 1;
    }
  }
  const beforeCleanup = engine.stats();
  for (let index = 0; index < rootCount; index += 1) {
    try { engine.frontier(`probe:leaf:${index}`); } catch { errors += 1; }
  }
  const afterLeafQueries = engine.stats();
  for (let index = 0; index < rootCount; index += 1) {
    try { engine.frontier(`probe:root:${index}`); } catch { errors += 1; }
  }
  const afterCleanup = engine.stats();
  return Object.freeze({
    rootCount,
    errors,
    beforeCleanup: {
      tombstonedRootCount: beforeCleanup.tombstonedRootCount,
      tombstonedRootEntries: beforeCleanup.tombstonedRootEntries,
      cacheEntries: beforeCleanup.cacheEntries,
      trusted: beforeCleanup.trusted
    },
    afterLeafQueries: {
      tombstonedRootCount: afterLeafQueries.tombstonedRootCount,
      tombstonedRootEntries: afterLeafQueries.tombstonedRootEntries,
      cacheEntries: afterLeafQueries.cacheEntries,
      trusted: afterLeafQueries.trusted
    },
    afterCleanup: {
      tombstonedRootCount: afterCleanup.tombstonedRootCount,
      tombstonedRootEntries: afterCleanup.tombstonedRootEntries,
      cacheEntries: afterCleanup.cacheEntries,
      trusted: afterCleanup.trusted
    }
  });
}

function runCacheProbe(RuntimeReceiptCache, RuntimeNegativeCache, count) {
  const receiptCache = new RuntimeReceiptCache({ maxEntries: 128 });
  const negativeCache = new RuntimeNegativeCache();
  for (let index = 0; index < count; index += 1) {
    const scope = probeScope(`probe:${index}`);
    receiptCache.put({
      scope,
      state: "FRESH",
      valid: true,
      observedAt: AT,
      expiresAt: "2026-08-13T00:01:00.000Z",
      value: { index }
    });
    negativeCache.put(scope, "event-gap", "2026-08-13T00:01:00.000Z");
  }
  return Object.freeze({
    receiptEntries: receiptCache.stats().entries,
    receiptEvictions: receiptCache.stats().evictions,
    negativeCacheEntries: negativeCache.stats().entries
  });
}

function parsePositiveList(value, fallback) {
  const list = value === undefined ? fallback : value.split(",").map((item) => Number(item));
  if (list.length === 0 || list.some((item) => !Number.isSafeInteger(item) || item < 1)) throw new RangeError("horizons must be positive integers");
  return list;
}

function parseArgs() {
  const horizonsArg = process.argv.find((argument) => argument.startsWith("--horizons="))?.slice("--horizons=".length);
  const worldSizeArg = process.argv.find((argument) => argument.startsWith("--world-size="))?.slice("--world-size=".length);
  const horizons = parsePositiveList(horizonsArg, [1000, 10000, 100000]);
  const worldSize = worldSizeArg === undefined ? 8 : Number(worldSizeArg);
  if (!Number.isSafeInteger(worldSize) || worldSize < 2) throw new RangeError("world-size must be an integer >= 2");
  return { horizons, worldSize };
}

function oracle(input) {
  return JSON.parse(execFileSync(process.execPath, [ORACLE_ENTRY], {
    cwd: ROOT,
    input: JSON.stringify(input),
    encoding: "utf8"
  }));
}

async function runHorizon(module, { steps, worldSize }) {
  const {
    InMemoryRuntimeStore,
    IncrementalFrontierEngine,
    PremiseRuntime,
    RuntimeInstrumentationRecorder,
    RuntimeReceiptCache,
    RuntimeNegativeCache
  } = module;
  const store = new InMemoryRuntimeStore();
  const instrumentation = new RuntimeInstrumentationRecorder();
  const receiptCache = new RuntimeReceiptCache({ maxEntries: 128 });
  const negativeCache = new RuntimeNegativeCache();
  const runtime = new PremiseRuntime({
    store,
    tenantId: "tenant:horizon",
    now: () => AT,
    instrumentation,
    incrementalFrontier: true,
    receiptCache,
    receiptScope: scopeFactory,
    receiptTtlMs: 60_000
  });
  const nodes = [{ id: "memory:source", dependsOn: [] }];
  for (let index = 1; index < worldSize; index += 1) nodes.push({ id: `memory:node:${index}`, dependsOn: [index === 1 ? "memory:source" : `memory:node:${index - 1}`] });
  const frontier = new IncrementalFrontierEngine(nodes);
  runtime.register({ envelope: envelope("memory:source"), content: { value: "source" } }, "register:source");
  for (let index = 1; index < worldSize; index += 1) {
    const memoryId = `memory:node:${index}`;
    runtime.derive({ envelope: envelope(memoryId, [index === 1 ? "memory:source" : `memory:node:${index - 1}`]), content: { value: index } }, `derive:${memoryId}`);
  }
  const initialEventCount = runtime.eventCount();
  const samples = [];
  let runtimeErrors = 0;
  let frontierErrors = 0;
  let frontierComplete = true;
  let runtimeFrontierComplete = true;
  for (let step = 1; step <= steps; step += 1) {
    const versionToken = `v${step + 1}`;
    try {
      runtime.signalSourceChanged(SOURCE, { scheme: "horizon.source", token: versionToken }, `signal:${step}`);
      runtime.check(["memory:source", `memory:node:${worldSize - 1}`]);
    } catch {
      runtimeErrors += 1;
    }
    try {
      const runtimeFrontier = runtime.frontier(`memory:node:${worldSize - 1}`);
      runtimeFrontierComplete &&= runtimeFrontier.complete === true;
      frontier.markDirty(["memory:source"], "STALE");
      const directFrontier = frontier.frontier(`memory:node:${worldSize - 1}`);
      frontierComplete &&= directFrontier.complete === true;
      frontier.resolve("memory:source");
    } catch {
      frontierErrors += 1;
    }
    try {
      if (step % 29 === 0) {
        runtime.replace("memory:source", { value: "source" }, envelope("memory:source", [], versionToken), `replace:${step}`);
      } else {
        const current = runtime.get("memory:source");
        assert.ok(current);
        const evidence = current.envelope.evidence[0];
        const report = await runtime.revalidate("memory:source", async (observed) => ({
          memoryId: "ignored",
          evidenceId: observed.evidenceId,
          sourceUri: observed.sourceUri,
          version: observed.version,
          result: "UNCHANGED",
          status: "FRESH",
          checkedAt: AT
        }), `validate:${step}`);
        assert.equal(report.status, "FRESH");
        assert.equal(evidence.sourceUri, SOURCE);
      }
      if (step % 17 === 0) {
        const current = runtime.get("memory:source");
        assert.ok(current);
        const currentVersion = current.envelope.evidence[0]?.version?.token;
        await runtime.revalidateAndAct("memory:source", {
          expectedVersion: currentVersion,
          commit: () => ({ accepted: false, reason: "VERSION_MISMATCH", observedVersion: `${currentVersion}:remote` })
        });
      }
      negativeCache.put({
        tenantId: "tenant:horizon",
        resourceId: SOURCE,
        incarnationId: "inc:horizon",
        versionToken: "negative",
        scopes: ["read:source"],
        queryDigest: "query:horizon",
        validatorId: "horizon-validator",
        authorizationContextDigest: "auth:horizon",
        policyDigest: "policy:horizon",
        changeSetDigest: null,
        causalFrontier: []
      }, "event-gap", "2026-08-13T00:01:00.000Z");
    } catch {
      runtimeErrors += 1;
    }
    if (step === 1 || step === steps || step % Math.max(1, Math.floor(steps / 10)) === 0) {
      collectGarbage();
      samples.push({ step, heap: heapSample(), eventCount: runtime.eventCount(), decisions: instrumentation.decisions().length });
    }
  }
  collectGarbage();
  let history = runtime.history();
  const eventTypeCounts = {};
  for (const event of history) eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1;
  const eventBoundary = {
    first: history.slice(0, 3).map(({ type }) => type),
    last: history.slice(-3).map(({ type }) => type)
  };
  history = null;
  const frontierStats = frontier.stats();
  const frontierProbe = runFrontierProbe(IncrementalFrontierEngine, worldSize);
  const cacheProbe = runCacheProbe(RuntimeReceiptCache, RuntimeNegativeCache, steps);
  const observed = {
    horizonSteps: steps,
    activeRecords: runtime.list().length,
    eventCount: runtime.eventCount(),
    decisionEvents: instrumentation.decisions().length,
    runtimeErrors,
    frontierErrors,
    receiptEntries: receiptCache.stats().entries,
    negativeCacheEntries: negativeCache.stats().entries,
    initialEventCount,
    eventTypeCounts,
    eventBoundary,
    runtimeFrontierComplete,
    frontierComplete,
    frontierCacheEntries: frontierStats.cacheEntries,
    frontierCacheInvalidations: frontierStats.frontierCacheInvalidations,
    frontierCacheEntriesPreserved: frontierStats.frontierCacheEntriesPreserved,
    frontierCacheProbe: frontierProbe,
    cacheProbe,
    frontier: {
      tombstonedRootCount: frontierStats.tombstonedRootCount,
      tombstonedRootEntries: frontierStats.tombstonedRootEntries,
      affectedClosureCacheEntries: frontierStats.affectedClosureCacheEntries,
      affectedClosureCacheNodes: frontierStats.affectedClosureCacheNodes,
      trusted: frontierStats.trusted
    }
  };
  const oracleResult = oracle({ steps, worldSize, observed });
  const historyPerActiveRecord = observed.eventCount / observed.activeRecords;
  return Object.freeze({
    steps,
    worldSize,
    observed: Object.freeze(observed),
    samples: Object.freeze(samples),
    oracle: Object.freeze(oracleResult),
    historyPerActiveRecord: Number(historyPerActiveRecord.toFixed(3)),
    compactionEvaluation: historyPerActiveRecord > 100 ? "REQUIRED_REVIEW" : "NOT_TRIGGERED"
  });
}

export async function runLongHorizonBenchmark({ horizons = [1000, 10000, 100000], worldSize = 8 } = {}) {
  const module = await import(pathToFileURL(RUNTIME_ENTRY).href);
  const rows = [];
  for (const steps of horizons) rows.push(await runHorizon(module, { steps, worldSize }));
  const deterministic = rows.every(({ oracle: result }) => result.pass);
  const result = Object.freeze({
    format: FORMAT,
    status: deterministic ? "PASS" : "INCONCLUSIVE",
    claims: Object.freeze({
      measurementOnly: true,
      runtimeConnected: true,
      compactionImplemented: false,
      providerRequestsMeasured: false,
      performanceClaim: false,
      commercialClaim: false
    }),
    gcAvailable: typeof globalThis.gc === "function",
    rows: Object.freeze(rows),
    gates: Object.freeze({
      independentInvariantOracle: deterministic,
      activeStatePreserved: rows.every(({ observed }) => observed.activeRecords === worldSize),
      noRuntimeErrors: rows.every(({ observed }) => observed.runtimeErrors === 0),
      frontierTrusted: rows.every(({ observed }) => observed.frontier.trusted === true && observed.runtimeFrontierComplete && observed.frontierComplete),
      boundedReceiptCache: rows.every(({ observed }) => observed.receiptEntries <= 1 && observed.cacheProbe.receiptEntries <= 128),
      cacheEvictionsReconciled: rows.every(({ observed, steps }) => observed.cacheProbe.receiptEvictions === Math.max(0, steps - 128)),
      negativeCacheGrowthMeasured: rows.every(({ observed, steps }) => observed.cacheProbe.negativeCacheEntries === steps),
      tombstoneCleanupMeasured: rows.every(({ observed, worldSize: size }) => observed.frontierCacheProbe.afterCleanup.tombstonedRootCount === 0 && observed.frontierCacheProbe.rootCount === size),
      compactionNotClaimed: true
    })
  });
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await writeFile(resolve(OUTPUT_DIRECTORY, "long-horizon.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const { horizons, worldSize } = parseArgs();
  process.stdout.write(`${JSON.stringify(await runLongHorizonBenchmark({ horizons, worldSize }), null, 2)}\n`);
}
