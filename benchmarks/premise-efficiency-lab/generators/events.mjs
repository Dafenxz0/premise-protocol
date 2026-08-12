import { createSeededRandom } from "./graphs.mjs";

const SCHEDULES = Object.freeze(["isolated", "simultaneous", "burst", "duplicate", "reordered", "gapped"]);

function asNodeIds(nodeIds) {
  if (!nodeIds || typeof nodeIds[Symbol.iterator] !== "function") throw new TypeError("nodeIds must be iterable");
  const result = [...nodeIds];
  if (result.length === 0 || result.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new RangeError("nodeIds must contain non-empty strings");
  }
  return [...new Set(result)];
}

function positiveInteger(value, name, fallback) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new RangeError(`${name} must be a positive integer`);
  return result;
}

function scheduleName(value) {
  const result = value ?? "isolated";
  if (!SCHEDULES.includes(result)) throw new RangeError(`unknown mutation schedule: ${result}`);
  return result;
}

export function createMutationEvents(options = {}) {
  const ids = asNodeIds(options.nodeIds);
  const schedule = scheduleName(options.schedule);
  const random = createSeededRandom(options.seed ?? "premise-efficiency-events");
  const startVersion = positiveInteger(options.startVersion, "startVersion", 1);
  const batchSize = positiveInteger(options.batchSize, "batchSize", Math.max(1, Math.ceil(ids.length / 3)));
  const ordered = [...ids];
  if (schedule === "simultaneous") ordered.sort(() => random() - 0.5);
  const events = [];
  let sequence = 1;
  for (let index = 0; index < ordered.length; index += 1) {
    const event = Object.freeze({
      eventId: `event-${String(sequence).padStart(4, "0")}`,
      nodeId: ordered[index],
      version: startVersion + sequence,
      sequence,
      batch: schedule === "burst" ? Math.floor(index / batchSize) + 1 : sequence,
      observedAt: sequence
    });
    events.push(event);
    sequence += 1;
  }
  if (schedule === "reordered") events.reverse();
  if (schedule === "duplicate" && events.length > 0) events.splice(1, 0, events[0]);
  if (schedule === "gapped" && events.length > 2) events.splice(1, 1);
  return Object.freeze({
    schedule,
    seed: String(options.seed ?? "premise-efficiency-events"),
    events: Object.freeze(events),
    complete: schedule !== "gapped"
  });
}

export function normalizeMutationEvents(input) {
  const source = Array.isArray(input) ? { events: input, complete: true } : input;
  if (!source || !Array.isArray(source.events)) throw new TypeError("event stream must contain events");
  const events = source.events.filter((event) => event && typeof event === "object");
  const unique = new Map();
  let duplicateCount = 0;
  let reordered = false;
  let previousSequence = 0;
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || typeof event.nodeId !== "string") throw new TypeError("invalid mutation event");
    if (event.sequence < previousSequence) reordered = true;
    previousSequence = event.sequence;
    if (unique.has(event.eventId)) {
      duplicateCount += 1;
      continue;
    }
    unique.set(event.eventId, event);
  }
  const normalized = [...unique.values()].sort((left, right) => left.sequence - right.sequence);
  const expected = normalized.length === 0 ? 0 : normalized[normalized.length - 1].sequence;
  const gap = source.complete === false || normalized.some((event, index) => event.sequence !== index + 1);
  return Object.freeze({
    events: Object.freeze(normalized),
    status: gap ? "UNKNOWN" : "FRESH",
    gap,
    reordered,
    duplicateCount,
    signalCount: normalized.length,
    batchCount: new Set(normalized.map((event) => event.batch ?? event.sequence)).size,
    expectedSignals: expected
  });
}

export function replayMutationEvents(previous = new Map(), stream) {
  const normalized = normalizeMutationEvents(stream);
  const state = new Map(previous);
  if (normalized.status === "UNKNOWN") return Object.freeze({ state, status: "UNKNOWN", applied: 0 });
  let applied = 0;
  for (const event of normalized.events) {
    const current = state.get(event.nodeId);
    if (current === undefined || event.version > current.version) {
      state.set(event.nodeId, Object.freeze({ version: event.version, eventId: event.eventId }));
      applied += 1;
    }
  }
  return Object.freeze({ state, status: "FRESH", applied });
}

export { SCHEDULES };
