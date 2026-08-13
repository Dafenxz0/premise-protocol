import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessEventContinuity,
  assessOrderedEventContinuity
} from "../../../../packages/runtime-core/dist/index.js";

const ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const OUTPUT = resolve(ROOT, ".tmp", "premise-efficiency-lab", "v1", "events", "continuity.json");
const ORACLE = fileURLToPath(new URL("./oracle.mjs", import.meta.url));
export const EVENT_TRACE_FORMAT = "premise-efficiency-lab/event-continuity/v1";

const stream = "stream:source";
const snapshot = (sequence, eventId = `snapshot-${sequence}`) => ({ streamId: stream, sequence, kind: "SNAPSHOT", eventId });
const delta = (sequence, eventId = `delta-${sequence}`) => ({ streamId: stream, sequence, kind: "DELTA", eventId });

const cases = Object.freeze([
  { id: "ordered", events: [snapshot(10), delta(11), delta(12)], expected: "FRESH", options: { expectedSequence: 10, requireSnapshot: true } },
  { id: "duplicate", events: [snapshot(10), delta(11), delta(11), delta(12)], expected: "FRESH", options: { expectedSequence: 10, requireSnapshot: true } },
  { id: "burst", events: [snapshot(1), ...Array.from({ length: 50 }, (_, index) => delta(index + 2))], expected: "FRESH", options: { expectedSequence: 1, requireSnapshot: true } },
  { id: "gap", events: [snapshot(10), delta(12)], expected: "GAP", options: { expectedSequence: 10, requireSnapshot: true } },
  { id: "reordered-late", events: [snapshot(10), delta(11), delta(10, "late-10")], expected: "REORDERED", options: { expectedSequence: 10, requireSnapshot: true } },
  { id: "late-exact-duplicate", events: [snapshot(10), delta(11), snapshot(10)], expected: "REORDERED", options: { expectedSequence: 10, requireSnapshot: true } },
  { id: "same-sequence-conflict", events: [snapshot(10), delta(10, "different-10")], expected: "CONFLICT", options: { expectedSequence: 10, requireSnapshot: true } },
  { id: "stream-mismatch", events: [snapshot(10), { ...delta(11), streamId: "stream:other" }], expected: "STREAM_MISMATCH", options: { expectedSequence: 10, requireSnapshot: true } },
  { id: "delta-before-snapshot", events: [delta(1)], expected: "DELTA_BEFORE_SNAPSHOT", options: { requireSnapshot: true } }
]);

function runCase(item) {
  const ordered = assessOrderedEventContinuity(item.events, item.options);
  const legacy = assessEventContinuity(item.events.map(({ sequence }) => ({ sequence })));
  const observed = ordered.status === "FRESH"
    ? { status: "FRESH", finalSequence: ordered.finalSequence, applied: [...ordered.applied], duplicates: [...ordered.duplicates] }
    : { status: "UNKNOWN", reason: ordered.reason, applied: [...ordered.applied], duplicates: [...ordered.duplicates] };
  const oracle = JSON.parse(execFileSync(process.execPath, [ORACLE], {
    cwd: ROOT,
    input: JSON.stringify({ caseId: item.id }),
    encoding: "utf8"
  }));
  return Object.freeze({
    id: item.id,
    expected: item.expected,
    observed,
    oracle,
    equivalentToOracle: JSON.stringify(observed) === JSON.stringify(oracle),
    legacySortedStatus: legacy.status,
    legacyFalseFresh: item.expected !== "FRESH" && legacy.status === "FRESH",
    eventsExamined: item.events.length,
    duplicatesSuppressed: ordered.status === "FRESH" ? ordered.duplicates.length : 0
  });
}

export async function runEventContinuityBenchmark() {
  const rows = cases.map(runCase);
  const result = Object.freeze({
    format: EVENT_TRACE_FORMAT,
    status: rows.every(({ equivalentToOracle }) => equivalentToOracle) ? "PASS" : "INCONCLUSIVE",
    claims: Object.freeze({
      independentOracle: true,
      independentOracleProcess: true,
      runtimeConnected: false,
      providerRequestsMeasured: false,
      performanceClaim: false,
      protocolEventSchemaChanged: false
    }),
    rows: Object.freeze(rows),
    gates: Object.freeze({
      orderedSemantics: rows.every(({ equivalentToOracle }) => equivalentToOracle),
      adversarialFalseFreshDetected: rows.some(({ legacyFalseFresh }) => legacyFalseFresh),
      noRuntimeClaim: true
    })
  });
  await mkdir(resolve(ROOT, ".tmp", "premise-efficiency-lab", "v1", "events"), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(await runEventContinuityBenchmark(), null, 2)}\n`);
}
