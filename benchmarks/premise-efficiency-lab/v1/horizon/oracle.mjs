import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This process deliberately has no runtime-core or runner import. It checks
// the raw runtime snapshot and decision trace, rather than trusting the
// runner's precomputed counts.
const EVENT_TYPES = new Set([
  "MemoryRegistered",
  "MemoryDerived",
  "SourceChanged",
  "MemoryStaled",
  "MemoryInvalidated",
  "MemoryRevalidated",
  "MemoryReplaced"
]);
const STATUSES = new Set(["FRESH", "STALE", "INVALID", "UNKNOWN"]);
const DECISIONS = new Set(["USABLE", "REVALIDATE", "REJECT", "ALLOW", "ACCEPTED"]);
const SOURCE = "source://horizon/source";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedCounts(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function countTypes(events) {
  const counts = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

function evaluateCore(input) {
  const { steps, worldSize, observed, snapshot, decisions } = isRecord(input) ? input : {};
  const events = isRecord(snapshot) && Array.isArray(snapshot.events) ? snapshot.events : [];
  const records = isRecord(snapshot) && Array.isArray(snapshot.records) ? snapshot.records : [];
  const replay = new Map();
  const dependencies = new Map();
  const eventDependencies = new Map();
  const eventIds = new Set();
  const idempotencyKeys = new Set();
  const errors = [];
  let latestSourceVersion;
  const addError = (code) => errors.push(code);

  if (!Number.isSafeInteger(steps) || steps < 1) addError("INVALID_STEPS");
  if (!Number.isSafeInteger(worldSize) || worldSize < 2) addError("INVALID_WORLD_SIZE");
  if (!isRecord(observed)) addError("MISSING_OBSERVED");
  if (!isRecord(snapshot) || snapshot.format !== "premise-runtime-snapshot" || snapshot.version !== 1) addError("INVALID_SNAPSHOT");
  if (!Array.isArray(decisions)) addError("MISSING_DECISIONS");

  for (const event of events) {
    if (!isRecord(event) || event.specVersion !== "premise/2" || typeof event.tenantId !== "string"
      || event.tenantId !== "tenant:horizon" || typeof event.eventId !== "string"
      || typeof event.operationId !== "string" || typeof event.idempotencyKey !== "string"
      || typeof event.requestDigest !== "string" || !event.requestDigest.startsWith("sha256:")
      || !EVENT_TYPES.has(event.type) || typeof event.occurredAt !== "string" || !isRecord(event.payload)) {
      addError("MALFORMED_EVENT");
      continue;
    }
    if (eventIds.has(event.eventId)) addError("DUPLICATE_EVENT_ID");
    if (idempotencyKeys.has(event.idempotencyKey)) addError("DUPLICATE_IDEMPOTENCY_KEY");
    eventIds.add(event.eventId);
    idempotencyKeys.add(event.idempotencyKey);
    const memoryId = event.memoryId;
    if (event.type !== "SourceChanged" && (typeof memoryId !== "string" || memoryId.length === 0)) {
      addError("MISSING_MEMORY_ID");
      continue;
    }
    if (event.type === "MemoryRegistered") {
      const envelope = event.payload.envelope;
      if (!isRecord(envelope) || envelope.memoryId !== memoryId || !isRecord(envelope.validity) || !STATUSES.has(envelope.validity.status)) addError("INVALID_REGISTERED_ENVELOPE");
      replay.set(memoryId, { status: isRecord(envelope?.validity) && STATUSES.has(envelope.validity.status) ? envelope.validity.status : "UNKNOWN" });
      const dependsOn = isRecord(envelope) && Array.isArray(envelope.dependsOn) ? [...envelope.dependsOn] : [];
      dependencies.set(memoryId, dependsOn);
      eventDependencies.set(memoryId, dependsOn);
    } else if (event.type === "MemoryDerived") {
      if (!Array.isArray(event.payload.dependsOn) || event.payload.dependsOn.length === 0) addError("INVALID_DERIVED_DEPENDENCIES");
      replay.set(memoryId, { status: "FRESH" });
      const dependsOn = Array.isArray(event.payload.dependsOn) ? [...event.payload.dependsOn] : [];
      dependencies.set(memoryId, dependsOn);
      eventDependencies.set(memoryId, dependsOn);
    } else if (event.type === "SourceChanged") {
      if (event.payload.sourceUri !== SOURCE || !isRecord(event.payload.version) || typeof event.payload.version.token !== "string") addError("INVALID_SOURCE_CHANGE");
      else latestSourceVersion = event.payload.version.token;
    } else if (event.type === "MemoryStaled") {
      if (event.payload.sourceUri !== SOURCE || !isRecord(event.payload.version) || event.payload.version.token !== latestSourceVersion) addError("INVALID_STALE_SOURCE");
      if (replay.get(memoryId)?.status !== "INVALID") replay.set(memoryId, { status: "STALE" });
    } else if (event.type === "MemoryInvalidated") {
      replay.set(memoryId, { status: "INVALID" });
    } else if (event.type === "MemoryRevalidated") {
      const status = event.payload.status;
      if (!STATUSES.has(status) || !["UNCHANGED", "CHANGED", "MISSING", "UNKNOWN"].includes(event.payload.result)) addError("INVALID_REVALIDATION");
      replay.set(memoryId, { status: STATUSES.has(status) ? status : "UNKNOWN" });
    } else if (event.type === "MemoryReplaced") {
      if ((event.payload.previousDigest !== undefined && typeof event.payload.previousDigest !== "string")
        || (event.payload.nextDigest !== undefined && typeof event.payload.nextDigest !== "string")) addError("INVALID_REPLACEMENT");
      replay.set(memoryId, { status: "FRESH" });
    }
  }

  const recordIds = new Set();
  for (const record of records) {
    const envelope = isRecord(record) ? record.envelope : undefined;
    if (!isRecord(envelope) || typeof envelope.memoryId !== "string" || envelope.tenantId !== "tenant:horizon" || !isRecord(envelope.validity) || !STATUSES.has(envelope.validity.status)) {
      addError("MALFORMED_RECORD");
      continue;
    }
    if (recordIds.has(envelope.memoryId)) addError("DUPLICATE_RECORD_ID");
    recordIds.add(envelope.memoryId);
    const dependsOn = Array.isArray(envelope.dependsOn) ? [...envelope.dependsOn] : [];
    dependencies.set(envelope.memoryId, dependsOn);
    if (eventDependencies.has(envelope.memoryId) && !equalJson(eventDependencies.get(envelope.memoryId), dependsOn)) addError("EVENT_RECORD_DEPENDENCY_MISMATCH");
    for (const dependency of dependsOn) if (dependency === envelope.memoryId || !recordIds.has(dependency) && !records.some((candidate) => candidate?.envelope?.memoryId === dependency)) addError("BROKEN_DEPENDENCY");
    const replayed = replay.get(envelope.memoryId);
    if (replayed === undefined || replayed.status !== envelope.validity.status) addError("REPLAY_STATE_MISMATCH");
  }

  const decisionsValid = Array.isArray(decisions) && decisions.every((decision) => isRecord(decision)
    && typeof decision.memoryId === "string" && recordIds.has(decision.memoryId) && DECISIONS.has(decision.decision));
  if (!decisionsValid) addError("INVALID_DECISION_TRACE");

  const counts = countTypes(events);
  const sourceChanges = events.filter((event) => event?.type === "SourceChanged");
  const registered = events.filter((event) => event?.type === "MemoryRegistered");
  const derived = events.filter((event) => event?.type === "MemoryDerived");
  const expectedMemoryIds = new Set(["memory:source", ...Array.from({ length: Math.max(0, worldSize - 1) }, (_, index) => `memory:node:${index + 1}`)]);
  const chainIsComplete = recordIds.size === worldSize && [...expectedMemoryIds].every((memoryId) => recordIds.has(memoryId));
  const sourceVersionsAreOrdered = sourceChanges.every((event, index) => event.payload.version.token === `v${index + 2}`);
  const eventBoundary = {
    first: events.slice(0, 3).map((event) => event?.type),
    last: events.slice(-3).map((event) => event?.type)
  };
  const probe = observed?.cacheProbe;
  const frontierProbe = observed?.frontierCacheProbe;
  const checks = {
    snapshot: isRecord(snapshot) && snapshot.format === "premise-runtime-snapshot" && snapshot.version === 1,
    chain: chainIsComplete && registered.length === 1 && derived.length === worldSize - 1,
    eventStructure: errors.every((code) => !["MALFORMED_EVENT", "DUPLICATE_EVENT_ID", "DUPLICATE_IDEMPOTENCY_KEY", "MISSING_MEMORY_ID"].includes(code)),
    replayMatchesRecords: errors.every((code) => code !== "REPLAY_STATE_MISMATCH"),
    sourceChanges: sourceChanges.length === steps && sourceVersionsAreOrdered,
    observedCounts: observed?.eventCount === events.length && observed?.decisionEvents === decisions?.length,
    observedTypes: equalJson(sortedCounts(observed?.eventTypeCounts ?? {}), sortedCounts(counts))
      && equalJson(observed?.eventBoundary, eventBoundary),
    activeState: observed?.activeRecords === records.length && records.length === worldSize,
    decisions: decisionsValid,
    runtimeErrors: observed?.runtimeErrors === 0 && observed?.frontierErrors === 0,
    receiptProbe: observed?.receiptEntries <= 1 && probe?.receiptEntries === Math.min(steps, 128) && probe?.receiptEvictions === Math.max(0, steps - 128),
    negativeProbe: probe?.negativeCacheEntries === steps,
    frontierProbe: frontierProbe?.errors === 0
      && frontierProbe.beforeCleanup?.tombstonedRootCount === worldSize
      && frontierProbe.beforeCleanup?.tombstonedRootEntries === worldSize * 2
      && frontierProbe.afterLeafQueries?.tombstonedRootEntries === worldSize
      && frontierProbe.afterCleanup?.tombstonedRootCount === 0
      && frontierProbe.afterCleanup?.tombstonedRootEntries === 0
      && frontierProbe.afterCleanup?.trusted === true
  };
  return { pass: errors.length === 0 && Object.values(checks).every(Boolean), checks, errors };
}

export function evaluateHorizonEvidence(input) {
  return evaluateCore(input);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const result = evaluateHorizonEvidence(input);
  // The parent process receives only a verdict. Detailed checks stay in this
  // isolated process and are never serialized into the public campaign report.
  process.stdout.write(`${JSON.stringify({ pass: result.pass })}\n`);
}
