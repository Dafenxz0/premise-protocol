import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  artifactDigest,
  loadBaselineRuntime
} from "../frontier/baseline-artifact.mjs";

export const RECEIPT_TRACE_FORMAT = "premise-efficiency-lab/receipt-reuse/v1";
export const RECEIPT_COUNTER_SCHEMA = "runtime-core/instrumentation/v1";
export const RECEIPT_BASELINE_MANIFEST = new URL("./baseline-manifest.json", import.meta.url);
const ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const CANDIDATE_ENTRY = resolve(ROOT, "packages/runtime-core/dist/index.js");
const RECEIPT_ORACLE_ENTRY = fileURLToPath(new URL("./oracle.mjs", import.meta.url));
const AT = "2026-08-13T00:00:00.000Z";

function clone(value) {
  return structuredClone(value);
}

function isoAfter(milliseconds) {
  return new Date(Date.parse(AT) + milliseconds).toISOString();
}

function record(memoryId, {
  tenantId = "tenant:receipt-lab",
  sourceUri = "source://shared",
  versionToken = "v1",
  evidenceId = "evidence:shared",
  authorizationContextDigest = "auth:reader",
  scopeOverrides = {},
  status = "FRESH"
} = {}) {
  const observedAt = AT;
  return {
    envelope: {
      specVersion: "premise/2",
      tenantId,
      memoryId,
      evidence: [{
        evidenceId,
        sourceUri,
        observedAt,
        version: { scheme: "deterministic.source", token: versionToken },
        validator: { id: "receipt-lab-validator", operation: "read" }
      }],
      confidence: { score: null, method: "receipt-lab", assessedAt: observedAt },
      conflicts: [],
      temporal: { asOf: observedAt },
      validity: { status, checkedAt: observedAt, policy: "VERSIONED" },
      dependsOn: [],
      signatures: []
    },
    content: { memoryId, authorizationContextDigest, scopeOverrides }
  };
}

function scopeFactory(evidence, runtimeRecord) {
  const overrides = runtimeRecord.content.scopeOverrides ?? {};
  return {
    ...overrides,
    tenantId: runtimeRecord.envelope.tenantId,
    resourceId: evidence.sourceUri,
    incarnationId: overrides.incarnationId ?? `inc:${evidence.evidenceId}`,
    versionToken: overrides.versionToken ?? `${evidence.version.scheme}:${evidence.version.token}`,
    scopes: overrides.scopes === undefined ? ["read:head"] : [...overrides.scopes],
    queryDigest: overrides.queryDigest ?? "query:current-version",
    validatorId: evidence.validator.id,
    authorizationContextDigest: runtimeRecord.content.authorizationContextDigest,
    policyDigest: overrides.policyDigest ?? "policy:versioned-read",
    changeSetDigest: overrides.changeSetDigest === undefined ? null : overrides.changeSetDigest,
    causalFrontier: overrides.causalFrontier === undefined ? [] : [...overrides.causalFrontier]
  };
}

function implementation(name, module) {
  const { PremiseRuntime, InMemoryRuntimeStore, RuntimeInstrumentationRecorder, RuntimeReceiptCache } = module;
  for (const [key, value] of Object.entries({ PremiseRuntime, InMemoryRuntimeStore, RuntimeInstrumentationRecorder })) {
    if (typeof value !== "function") throw new Error(`${name.toUpperCase()}_EXPORT_MISSING:${key}`);
  }
  return Object.freeze({
    name,
    Runtime: PremiseRuntime,
    Store: InMemoryRuntimeStore,
    Recorder: RuntimeInstrumentationRecorder,
    Cache: RuntimeReceiptCache,
    module
  });
}

function makeHarness(impl, {
  receiptReuse,
  now = () => AT,
  ttlMs = 1000,
  tenantId = "tenant:receipt-lab",
  cache: suppliedCache,
  receiptScopeFactory = scopeFactory
} = {}) {
  const recorder = new impl.Recorder();
  const store = new impl.Store();
  const cache = receiptReuse === true ? (suppliedCache ?? new impl.Cache({ maxEntries: 128 })) : undefined;
  const runtime = new impl.Runtime({
    store,
    tenantId,
    now,
    instrumentation: recorder,
    ...(cache === undefined ? {} : { receiptCache: cache, receiptScope: receiptScopeFactory, receiptTtlMs: ttlMs })
  });
  return { runtime, recorder, cache };
}

function register(runtime, records) {
  for (const item of records) runtime.register(item, `register:${item.envelope.memoryId}`);
}

function reportFor(item, now, result = "UNCHANGED", version) {
  return {
    memoryId: item.envelope.memoryId,
    evidenceId: item.envelope.evidence[0].evidenceId,
    result,
    status: result === "UNCHANGED" ? "FRESH" : result === "UNKNOWN" ? "UNKNOWN" : "INVALID",
    checkedAt: now(),
    sourceUri: item.envelope.evidence[0].sourceUri,
    ...(version === undefined ? {} : { version })
  };
}

function visibleState(runtime, ids) {
  return ids.map((id) => {
    const current = runtime.get(id);
    assert.ok(current, `missing visible record ${id}`);
    return {
      memoryId: id,
      status: current.envelope.validity.status,
      version: current.envelope.evidence[0]?.version ?? null
    };
  });
}

function physicalCounters(harness) {
  const counters = harness.recorder.snapshot();
  return Object.freeze({
    validations: harness.physicalValidations ?? 0,
    receiptLookups: counters.receiptLookups,
    receiptHits: counters.receiptHits,
    receiptMisses: counters.receiptMisses,
    staleReceiptRejections: counters.staleReceiptRejections,
    singleFlightLeaders: counters.singleFlightLeaders,
    singleFlightJoins: counters.singleFlightJoins,
    singleFlightSplits: counters.singleFlightSplits,
    recordReads: counters.recordReads,
    recordBatchReads: counters.recordBatchReads,
    eventContinuityChecks: counters.eventContinuityChecks
  });
}

function counterDelta(before, after) {
  return Object.freeze(Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - (before[key] ?? 0)])));
}

function normalizeReport(report) {
  return clone(report);
}

function normalizeError(error) {
  return {
    name: typeof error?.name === "string" ? error.name : "Error",
    message: String(error?.message ?? error)
  };
}

function normalizeEvent(event) {
  const { eventId: _eventId, operationId: _operationId, ...stable } = event;
  if (typeof stable.idempotencyKey === "string" && stable.idempotencyKey.startsWith("evt_")) {
    stable.idempotencyKey = `${stable.type}:${stable.memoryId ?? ""}:${stable.requestDigest}`;
  }
  return clone(stable);
}

function stableRecordState(runtime, ids) {
  return ids.map((id) => {
    const current = runtime.get(id);
    assert.ok(current, `missing final record ${id}`);
    return clone(current);
  });
}

async function runWave(harness, ids, validator, { concurrent = false, eventPrefix = "wave" } = {}) {
  if (concurrent) return Promise.all(ids.map((id) => harness.runtime.revalidate(id, validator, `${eventPrefix}:${id}`)));
  const reports = [];
  for (const id of ids) reports.push(await harness.runtime.revalidate(id, validator, `${eventPrefix}:${id}`));
  return reports;
}

async function runOne(impl, scenario) {
  let currentNow = AT;
  const now = () => currentNow;
  const harness = makeHarness(impl, {
    receiptReuse: scenario.receiptReuse,
    now,
    ttlMs: scenario.ttlMs ?? 1000,
    tenantId: scenario.tenantId ?? "tenant:receipt-lab",
    cache: scenario.sharedCache,
    receiptScopeFactory: scenario.scopeFactory ?? scopeFactory
  });
  harness.physicalValidations = 0;
  let rotated = false;
  const validator = async (evidence, runtimeRecord) => {
    harness.physicalValidations += 1;
    if (scenario.delayMs !== undefined) await new Promise((resolvePromise) => setTimeout(resolvePromise, scenario.delayMs));
    if (scenario.validatorMode === "error" && harness.physicalValidations === 1) throw new Error("synthetic validator failure");
    if (scenario.validatorMode === "changed" || (scenario.validatorMode === "rotate" && rotated === true)) {
      return reportFor(runtimeRecord, now, "CHANGED");
    }
    return reportFor(runtimeRecord, now, "UNCHANGED", scenario.reportVersion);
  };
  const ids = [];
  const records = scenario.records.map((item) => {
    ids.push(item.envelope.memoryId);
    return item;
  });
  register(harness.runtime, records);
  const errors = [];
  const waves = [];
  const reportLog = [];
  const phaseCounters = {};
  const observeWave = (phase, reports) => {
    const normalized = reports.map(normalizeReport);
    reportLog.push(...normalized.map((report) => ({ phase, report })));
    return normalized;
  };
  const observeError = (phase, error) => {
    const normalized = normalizeError(error);
    errors.push({ phase, ...normalized });
    return normalized;
  };
  for (const [waveIndex, wave] of (scenario.waves ?? []).entries()) {
    try {
      const reports = await runWave(harness, ids, validator, { concurrent: wave.concurrent === true, eventPrefix: `wave-${waveIndex}` });
      waves.push({ phase: `wave-${waveIndex}`, reports: observeWave(`wave-${waveIndex}`, reports) });
    } catch (error) {
      const normalized = observeError(`wave-${waveIndex}`, error);
      waves.push({ phase: `wave-${waveIndex}`, error: normalized });
    }
  }
  if (scenario.afterWaves === "rotate") {
    const before = physicalCounters(harness);
    const beforeSignalEntries = harness.cache?.stats().entries ?? null;
    harness.runtime.signalSourceChanged("source://shared", { scheme: "deterministic.source", token: "v2" }, "source-rotate-v2");
    rotated = true;
    const afterSignalEntries = harness.cache?.stats().entries ?? null;
    try {
      const reports = await runWave(harness, ids, validator, { eventPrefix: "rotate" });
      waves.push({ phase: "rotate", reports: observeWave("rotate", reports) });
    } catch (error) {
      const normalized = observeError("rotate", error);
      waves.push({ phase: "rotate", error: normalized });
    }
    phaseCounters.rotate = {
      ...counterDelta(before, physicalCounters(harness)),
      beforeSignalEntries,
      afterSignalEntries
    };
  }
  if (scenario.afterWaves === "expire") {
    const before = physicalCounters(harness);
    currentNow = isoAfter((scenario.ttlMs ?? 1000) + 1);
    try {
      const reports = await runWave(harness, ids, validator, { eventPrefix: "expire" });
      waves.push({ phase: "expire", reports: observeWave("expire", reports) });
    } catch (error) {
      const normalized = observeError("expire", error);
      waves.push({ phase: "expire", error: normalized });
    }
    phaseCounters.expire = counterDelta(before, physicalCounters(harness));
  }
  if (scenario.afterWaves === "error") {
    try {
      await harness.runtime.revalidate(ids[0], validator, "error:first");
    } catch (error) {
      observeError("error-first", error);
    }
    try {
      const reports = [await harness.runtime.revalidate(ids[0], validator, "error:retry")];
      waves.push({ phase: "error-retry", reports: observeWave("error-retry", reports) });
    } catch (error) {
      const normalized = observeError("error-retry", error);
      waves.push({ phase: "error-retry", error: normalized });
    }
  }
  if (scenario.afterWaves === "toctou") {
    const before = physicalCounters(harness);
    let release;
    const pending = new Promise((resolvePromise) => { release = resolvePromise; });
    let pendingStarted = false;
    const raceValidator = async (_evidence, runtimeRecord) => {
      harness.physicalValidations += 1;
      pendingStarted = true;
      await pending;
      return reportFor(runtimeRecord, now, "UNCHANGED");
    };
    const race = harness.runtime.revalidate(ids[0], raceValidator, "toctou:race");
    while (!pendingStarted) await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    harness.runtime.signalSourceChanged("source://shared", { scheme: "deterministic.source", token: "v2" }, "source-toctou-v2");
    release();
    try {
      observeWave("in-flight-invalidation-fence", [await race]);
    } catch (error) {
      observeError("in-flight-invalidation-fence", error);
    }
    phaseCounters.toctou = counterDelta(before, physicalCounters(harness));
  }
  const cacheStats = harness.cache?.stats() ?? null;
  return Object.freeze({
    implementation: impl.name,
    receiptReuse: scenario.receiptReuse,
    waves: Object.freeze(waves),
    errors: Object.freeze(errors),
    reports: Object.freeze(reportLog),
    counters: physicalCounters(harness),
    phaseCounters: Object.freeze(phaseCounters),
    cache: cacheStats,
    visibleState: visibleState(harness.runtime, ids),
    recordState: stableRecordState(harness.runtime, ids),
    eventCount: harness.runtime.eventCount(),
    history: Object.freeze(harness.runtime.history().map(normalizeEvent))
  });
}

async function runTenantIsolation(impl, scenario) {
  const sharedCache = scenario.receiptReuse === true ? new impl.Cache({ maxEntries: 128 }) : undefined;
  const results = [];
  for (const tenantId of ["tenant:one", "tenant:two"]) {
    results.push(await runOne(impl, {
      ...scenario,
      tenantIsolation: false,
      tenantId,
      sharedCache,
      records: [record("memory:tenant-shared", {
        tenantId,
        sourceUri: "source://tenant-shared",
        evidenceId: "evidence:tenant-shared"
      })]
    }));
  }
  const sum = (key) => results.reduce((total, item) => total + item.counters[key], 0);
  const counters = Object.freeze(Object.fromEntries(Object.keys(results[0].counters).map((key) => [key, sum(key)])));
  return Object.freeze({
    implementation: impl.name,
    receiptReuse: scenario.receiptReuse,
    waves: Object.freeze(results.flatMap(({ waves }) => waves)),
    errors: Object.freeze(results.flatMap(({ errors }) => errors)),
    reports: Object.freeze(results.flatMap(({ reports }) => reports)),
    counters,
    phaseCounters: Object.freeze({}),
    cache: results.at(-1)?.cache ?? null,
    visibleState: Object.freeze(results.flatMap(({ visibleState }) => visibleState)),
    recordState: Object.freeze(results.flatMap(({ recordState }) => recordState)),
    eventCount: results.reduce((total, item) => total + item.eventCount, 0),
    history: Object.freeze(results.flatMap(({ history }) => history))
  });
}

async function runScenario(impl, scenario, receiptReuse) {
  const configured = { ...scenario, receiptReuse };
  return scenario.tenantIsolation ? runTenantIsolation(impl, configured) : runOne(impl, configured);
}

function scenarioSet(profile = "smoke") {
  const size = profile === "smoke" ? 24 : profile === "medium" ? 1000 : profile === "full" ? 10000 : undefined;
  if (size === undefined) throw new RangeError(`unknown receipt profile: ${profile}`);
  const stampedeSize = profile === "smoke" ? 48 : size;
  const shared = (count, options = {}) => Array.from({ length: count }, (_, index) => record(`memory:${index.toString().padStart(5, "0")}`, options));
  const pair = (label, options = {}) => [
    record(`memory:scope:${label}:a`, options),
    record(`memory:scope:${label}:b`, options)
  ];
  const scopeMatrix = [
    ...pair("base"),
    ...pair("resource", { sourceUri: "source://resource-variant" }),
    ...pair("incarnation", { evidenceId: "evidence:incarnation-variant" }),
    ...pair("version", { versionToken: "v2" }),
    ...pair("scopes", { scopeOverrides: { scopes: ["read:head", "read:metadata"] } }),
    ...pair("query", { scopeOverrides: { queryDigest: "query:alternate" } }),
    ...pair("policy", { scopeOverrides: { policyDigest: "policy:strict" } }),
    ...pair("change-set", { scopeOverrides: { changeSetDigest: "changes:1" } }),
    ...pair("frontier", { scopeOverrides: { causalFrontier: ["event:1"] } })
  ];
  return [
    {
      id: "sequential-completed-reuse",
      description: "Repeated sequential validations reuse one exact completed receipt.",
      records: shared(size),
      waves: [{}, {}]
    },
    {
      id: "concurrent-stampede",
      description: "Concurrent identical validations still coalesce through single-flight.",
      records: shared(stampedeSize),
      waves: [{ concurrent: true }],
      delayMs: 2
    },
    {
      id: "authorization-isolation",
      description: "Different authorization contexts never share a completed receipt.",
      records: Array.from({ length: size }, (_, index) => record(`memory:${index.toString().padStart(5, "0")}`, { authorizationContextDigest: index % 2 === 0 ? "auth:reader" : "auth:admin" })),
      waves: [{}]
    },
    {
      id: "scope-matrix",
      description: "Resource, incarnation, version, scope, query, policy, change-set and frontier dimensions remain isolated while exact pairs share.",
      records: scopeMatrix,
      uniqueScopes: 9,
      waves: [{}]
    },
    {
      id: "tenant-isolation",
      description: "A shared cache never crosses runtime tenant boundaries.",
      records: [record("memory:tenant-shared")],
      tenantIsolation: true,
      waves: [{}]
    },
    {
      id: "incomplete-scope",
      description: "An incomplete scope disables sharing instead of creating a partial key.",
      records: shared(1),
      waves: [{}, {}],
      scopeFactory: () => undefined
    },
    {
      id: "source-rotation",
      description: "A source invalidation removes the old receipt before revalidation.",
      records: shared(profile === "smoke" ? 12 : size),
      waves: [{}],
      afterWaves: "rotate",
      validatorMode: "rotate"
    },
    {
      id: "expiry",
      description: "Expired receipts cause physical validation again.",
      records: shared(profile === "smoke" ? 12 : size),
      waves: [{}],
      afterWaves: "expire",
      ttlMs: 10
    },
    {
      id: "failure-not-cached",
      description: "A validator failure is not converted into a reusable receipt.",
      records: shared(1),
      waves: [],
      afterWaves: "error",
      validatorMode: "error"
    },
    {
      id: "in-flight-invalidation-fence",
      description: "A validation crossing an invalidation cannot repopulate the completed-receipt cache.",
      records: shared(1),
      waves: [],
      afterWaves: "toctou"
    }
  ];
}

function compareScenario(baseline, candidate, scenario) {
  const semanticChecks = Object.freeze({
    visibleState: JSON.stringify(baseline.visibleState) === JSON.stringify(candidate.visibleState),
    recordState: JSON.stringify(baseline.recordState) === JSON.stringify(candidate.recordState),
    reports: JSON.stringify(baseline.reports) === JSON.stringify(candidate.reports),
    errors: JSON.stringify(baseline.errors) === JSON.stringify(candidate.errors),
    history: JSON.stringify(baseline.history) === JSON.stringify(candidate.history)
  });
  const semanticEquivalent = Object.values(semanticChecks).every(Boolean);
  const oracleInput = JSON.stringify({
    scenarioId: scenario.id,
    recordCount: scenario.records.length,
    uniqueScopes: scenario.uniqueScopes
  });
  const expected = JSON.parse(execFileSync(process.execPath, [RECEIPT_ORACLE_ENTRY], {
    cwd: ROOT,
    input: oracleInput,
    encoding: "utf8"
  }));
  const oracle = Object.freeze({
    process: "separate-node-process",
    expected,
    baseline: baseline.counters.validations === expected.baseline
      && baseline.visibleState.every(({ status }) => status === expected.status),
    candidate: candidate.counters.validations === expected.candidate
      && candidate.visibleState.every(({ status }) => status === expected.status)
  });
  const scopeSafe = scenario.id === "authorization-isolation"
    ? candidate.counters.validations === 2
    : scenario.id === "scope-matrix"
      ? candidate.counters.validations === scenario.uniqueScopes
      : scenario.id === "tenant-isolation"
        ? candidate.counters.validations === 2
        : scenario.id === "incomplete-scope"
          ? candidate.counters.validations === scenario.records.length * 2 && (candidate.cache?.entries ?? 0) === 0
          : true;
  const staleSafe = scenario.id !== "source-rotation"
    || (candidate.phaseCounters.rotate?.beforeSignalEntries ?? 0) > 0
      && candidate.phaseCounters.rotate?.afterSignalEntries === 0
      && candidate.phaseCounters.rotate?.receiptHits === 0;
  const failureSafe = scenario.id !== "failure-not-cached"
    || candidate.counters.validations === 2
      && (candidate.cache?.entries ?? 0) === 1;
  const toctouSafe = scenario.id !== "in-flight-invalidation-fence"
    || (candidate.cache?.entries ?? 0) === 0;
  const accounting = candidate.counters.receiptLookups === candidate.counters.receiptHits
    + candidate.counters.receiptMisses + candidate.counters.staleReceiptRejections;
  const improvement = baseline.counters.validations === 0
    ? 0
    : (1 - candidate.counters.validations / baseline.counters.validations) * 100;
  return Object.freeze({
    id: scenario.id,
    description: scenario.description,
    semanticEquivalent,
    semanticChecks,
    scopeSafe,
    staleSafe,
    failureSafe,
    toctouSafe,
    oracle,
    accounting,
    gate: semanticEquivalent && scopeSafe && staleSafe && failureSafe && toctouSafe && oracle.baseline && oracle.candidate && accounting,
    validationReductionPercent: Number(improvement.toFixed(2)),
    baseline: baseline.counters,
    candidate: candidate.counters,
    baselineCache: baseline.cache,
    candidateCache: candidate.cache,
    baselinePhases: baseline.phaseCounters,
    candidatePhases: candidate.phaseCounters
  });
}

function git(command, args) {
  return execFileSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export async function runReceiptReuseBenchmark({ profile = "smoke" } = {}) {
  const candidateModule = await import(pathToFileURL(CANDIDATE_ENTRY).href);
  const baselineLoaded = await loadBaselineRuntime({ manifestFile: RECEIPT_BASELINE_MANIFEST });
  const candidate = implementation("candidate", candidateModule);
  const baseline = implementation("baseline", baselineLoaded.module);
  const candidateArtifact = await artifactDigest(ROOT);
  const scenarios = scenarioSet(profile);
  const rows = [];
  for (const scenario of scenarios) {
    const baselineResult = await runScenario(baseline, scenario, false);
    const candidateResult = await runScenario(candidate, scenario, true);
    rows.push(compareScenario(baselineResult, candidateResult, scenario));
  }
  const clean = git("git", ["status", "--porcelain=v1", "--untracked-files=all"]) === "";
  const rowsPass = rows.every((row) => row.gate);
  const result = Object.freeze({
    format: RECEIPT_TRACE_FORMAT,
    counterSchema: RECEIPT_COUNTER_SCHEMA,
    profile,
    status: rowsPass && clean ? "PASS" : "INCONCLUSIVE",
    eligibility: clean ? "PASS" : "INCONCLUSIVE_DIRTY_CANDIDATE",
    claims: Object.freeze({
      physicalValidatorCallsMeasured: true,
      independentOracleProcess: true,
      semanticEquivalenceFullTrace: true,
      externalProviderCostMeasured: false,
      tokensMeasured: false,
      commercialClaim: false
    }),
    candidate: Object.freeze({
      commit: git("git", ["rev-parse", "HEAD"]),
      dirty: git("git", ["status", "--porcelain=v1", "--untracked-files=all"]) !== "",
      artifactDigest: candidateArtifact.digest,
      artifactFiles: candidateArtifact.files
    }),
    baseline: Object.freeze({
      commit: baselineLoaded.commit,
      artifactDigest: baselineLoaded.artifactDigest,
      artifactFiles: baselineLoaded.artifactFiles,
      manifest: baselineLoaded.manifest
    }),
    rows: Object.freeze(rows),
    gates: Object.freeze({
      allSemanticsEquivalent: rows.every(({ semanticEquivalent }) => semanticEquivalent),
      independentOracle: rows.every(({ oracle }) => oracle.baseline && oracle.candidate),
      receiptAccounting: rows.every(({ accounting }) => accounting),
      authorizationIsolation: rows.find(({ id }) => id === "authorization-isolation")?.scopeSafe === true,
      scopeMatrixIsolation: rows.find(({ id }) => id === "scope-matrix")?.scopeSafe === true,
      tenantIsolation: rows.find(({ id }) => id === "tenant-isolation")?.scopeSafe === true,
      incompleteScopeSafety: rows.find(({ id }) => id === "incomplete-scope")?.scopeSafe === true,
      invalidationSafety: rows.find(({ id }) => id === "source-rotation")?.staleSafe === true,
      failureSafety: rows.find(({ id }) => id === "failure-not-cached")?.failureSafe === true,
      inFlightInvalidationSafety: rows.find(({ id }) => id === "in-flight-invalidation-fence")?.toctouSafe === true
    })
  });
  const outputDirectory = resolve(ROOT, ".tmp", "premise-efficiency-lab", "v1", "receipts");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, `receipt-reuse-${profile}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const profileArg = process.argv.find((argument) => argument.startsWith("--profile="));
  process.stdout.write(`${JSON.stringify(await runReceiptReuseBenchmark({ profile: profileArg?.slice("--profile=".length) ?? "smoke" }), null, 2)}\n`);
}
