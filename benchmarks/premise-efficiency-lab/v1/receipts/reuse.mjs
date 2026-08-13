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
    content: { memoryId, authorizationContextDigest }
  };
}

function scopeFactory(evidence, runtimeRecord) {
  return {
    tenantId: runtimeRecord.envelope.tenantId,
    resourceId: evidence.sourceUri,
    incarnationId: `inc:${evidence.evidenceId}`,
    versionToken: `${evidence.version.scheme}:${evidence.version.token}`,
    scopes: ["read:head"],
    queryDigest: "query:current-version",
    validatorId: evidence.validator.id,
    authorizationContextDigest: runtimeRecord.content.authorizationContextDigest,
    policyDigest: "policy:versioned-read",
    changeSetDigest: null,
    causalFrontier: []
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

function makeHarness(impl, { receiptReuse, now = () => AT, ttlMs = 1000 } = {}) {
  const recorder = new impl.Recorder();
  const store = new impl.Store();
  const cache = receiptReuse === true ? new impl.Cache({ maxEntries: 128 }) : undefined;
  const runtime = new impl.Runtime({
    store,
    tenantId: "tenant:receipt-lab",
    now,
    instrumentation: recorder,
    ...(cache === undefined ? {} : { receiptCache: cache, receiptScope: scopeFactory, receiptTtlMs: ttlMs })
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

async function runWave(harness, ids, validator, { concurrent = false, eventPrefix = "wave" } = {}) {
  if (concurrent) return Promise.all(ids.map((id) => harness.runtime.revalidate(id, validator, `${eventPrefix}:${id}`)));
  const reports = [];
  for (const id of ids) reports.push(await harness.runtime.revalidate(id, validator, `${eventPrefix}:${id}`));
  return reports;
}

async function runOne(impl, scenario) {
  let currentNow = AT;
  const now = () => currentNow;
  const harness = makeHarness(impl, { receiptReuse: scenario.receiptReuse, now, ttlMs: scenario.ttlMs ?? 1000 });
  harness.physicalValidations = 0;
  const validator = async (evidence, runtimeRecord) => {
    harness.physicalValidations += 1;
    if (scenario.delayMs !== undefined) await new Promise((resolvePromise) => setTimeout(resolvePromise, scenario.delayMs));
    if (scenario.validatorMode === "error" && harness.physicalValidations === 1) throw new Error("synthetic validator failure");
    if (scenario.validatorMode === "changed" || (scenario.validatorMode === "rotate" && scenario.rotated === true)) {
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
  const phaseCounters = {};
  for (const [waveIndex, wave] of (scenario.waves ?? []).entries()) {
    try {
      const reports = await runWave(harness, ids, validator, { concurrent: wave.concurrent === true, eventPrefix: `wave-${waveIndex}` });
      waves.push({ reports: reports.length });
    } catch (error) {
      errors.push(String(error?.message ?? error));
      waves.push({ error: String(error?.message ?? error) });
    }
  }
  if (scenario.afterWaves === "rotate") {
    const before = physicalCounters(harness);
    harness.runtime.signalSourceChanged("source://shared", { scheme: "deterministic.source", token: "v2" }, "source-rotate-v2");
    scenario.rotated = true;
    try {
      await runWave(harness, ids, validator, { eventPrefix: "rotate" });
      waves.push({ after: "rotate", reports: ids.length });
    } catch (error) {
      errors.push(String(error?.message ?? error));
      waves.push({ after: "rotate", error: String(error?.message ?? error) });
    }
    phaseCounters.rotate = counterDelta(before, physicalCounters(harness));
  }
  if (scenario.afterWaves === "expire") {
    const before = physicalCounters(harness);
    currentNow = isoAfter((scenario.ttlMs ?? 1000) + 1);
    try {
      await runWave(harness, ids, validator, { eventPrefix: "expire" });
      waves.push({ after: "expire", reports: ids.length });
    } catch (error) {
      errors.push(String(error?.message ?? error));
      waves.push({ after: "expire", error: String(error?.message ?? error) });
    }
    phaseCounters.expire = counterDelta(before, physicalCounters(harness));
  }
  if (scenario.afterWaves === "error") {
    try {
      await harness.runtime.revalidate(ids[0], validator, "error:first");
    } catch (error) {
      errors.push(String(error?.message ?? error));
    }
    await harness.runtime.revalidate(ids[0], validator, "error:retry");
    waves.push({ after: "error-retry", reports: 1 });
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
    try { await race; } catch (error) { errors.push(String(error?.message ?? error)); }
    phaseCounters.toctou = counterDelta(before, physicalCounters(harness));
  }
  const cacheStats = harness.cache?.stats() ?? null;
  return Object.freeze({
    implementation: impl.name,
    receiptReuse: scenario.receiptReuse,
    waves: Object.freeze(waves),
    errors: Object.freeze(errors),
    counters: physicalCounters(harness),
    phaseCounters: Object.freeze(phaseCounters),
    cache: cacheStats,
    visibleState: visibleState(harness.runtime, ids),
    eventCount: harness.runtime.eventCount()
  });
}

function scenarioSet(profile = "smoke") {
  const size = profile === "smoke" ? 24 : profile === "medium" ? 1000 : profile === "full" ? 10000 : undefined;
  if (size === undefined) throw new RangeError(`unknown receipt profile: ${profile}`);
  const stampedeSize = profile === "smoke" ? 48 : size;
  const shared = (count, options = {}) => Array.from({ length: count }, (_, index) => record(`memory:${index.toString().padStart(5, "0")}`, options));
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
      id: "toctou-invalidation",
      description: "A validation crossing an invalidation cannot repopulate the cache.",
      records: shared(1),
      waves: [],
      afterWaves: "toctou"
    }
  ];
}

function compareScenario(baseline, candidate, scenario) {
  const baselineState = JSON.stringify(baseline.visibleState);
  const candidateState = JSON.stringify(candidate.visibleState);
  const semanticEquivalent = baselineState === candidateState
    && baseline.errors.length === candidate.errors.length
    && baseline.eventCount === candidate.eventCount;
  const scopeSafe = scenario.id !== "authorization-isolation"
    || candidate.counters.validations === 2;
  const staleSafe = scenario.id !== "source-rotation"
    || candidate.phaseCounters.rotate?.receiptHits === 0;
  const failureSafe = scenario.id !== "failure-not-cached"
    || candidate.counters.validations === 2;
  const toctouSafe = scenario.id !== "toctou-invalidation"
    || (candidate.cache?.entries ?? 0) === 0;
  const expected = {
    "sequential-completed-reuse": { baseline: scenario.records.length * 2, candidate: 1, status: "FRESH" },
    "concurrent-stampede": { baseline: 1, candidate: 1, status: "FRESH" },
    "authorization-isolation": { baseline: scenario.records.length, candidate: 2, status: "FRESH" },
    "source-rotation": { baseline: scenario.records.length * 2, candidate: scenario.records.length + 1, status: "INVALID" },
    "expiry": { baseline: scenario.records.length * 2, candidate: 2, status: "FRESH" },
    "failure-not-cached": { baseline: 2, candidate: 2, status: "FRESH" },
    "toctou-invalidation": { baseline: 1, candidate: 1, status: "STALE" }
  }[scenario.id];
  if (expected === undefined) throw new Error(`missing receipt oracle for ${scenario.id}`);
  const oracle = Object.freeze({
    baseline: baseline.counters.validations === expected.baseline
      && baseline.visibleState.every(({ status }) => status === expected.status),
    candidate: candidate.counters.validations === expected.candidate
      && candidate.visibleState.every(({ status }) => status === expected.status)
  });
  const accounting = candidate.counters.receiptLookups === candidate.counters.receiptHits
    + candidate.counters.receiptMisses + candidate.counters.staleReceiptRejections;
  const improvement = baseline.counters.validations === 0
    ? 0
    : (1 - candidate.counters.validations / baseline.counters.validations) * 100;
  return Object.freeze({
    id: scenario.id,
    description: scenario.description,
    semanticEquivalent,
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
    const baselineResult = await runOne(baseline, { ...scenario, receiptReuse: false });
    const candidateResult = await runOne(candidate, { ...scenario, receiptReuse: true });
    rows.push(compareScenario(baselineResult, candidateResult, scenario));
  }
  const result = Object.freeze({
    format: RECEIPT_TRACE_FORMAT,
    counterSchema: RECEIPT_COUNTER_SCHEMA,
    profile,
    status: rows.every((row) => row.gate) ? "PASS" : "INCONCLUSIVE",
    eligibility: git("git", ["status", "--porcelain=v1", "--untracked-files=all"]) === "" ? "PASS" : "INCONCLUSIVE_DIRTY_CANDIDATE",
    claims: Object.freeze({
      physicalValidatorCallsMeasured: true,
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
      invalidationSafety: rows.find(({ id }) => id === "source-rotation")?.staleSafe === true,
      failureSafety: rows.find(({ id }) => id === "failure-not-cached")?.failureSafe === true,
      toctouSafety: rows.find(({ id }) => id === "toctou-invalidation")?.toctouSafe === true
    })
  });
  const outputDirectory = resolve(ROOT, ".tmp", "premise-efficiency-lab", "v1", "receipts");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, "receipt-reuse.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const profileArg = process.argv.find((argument) => argument.startsWith("--profile="));
  process.stdout.write(`${JSON.stringify(await runReceiptReuseBenchmark({ profile: profileArg?.slice("--profile=".length) ?? "smoke" }), null, 2)}\n`);
}
