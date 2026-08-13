import { readFileSync } from "node:fs";

// Separate process, no runtime or runner imports. The expected trace is kept
// independent so the implementation cannot certify itself by reusing output.
const expected = Object.freeze({
  ordered: { status: "FRESH", finalSequence: 12, applied: [10, 11, 12], duplicates: [] },
  duplicate: { status: "FRESH", finalSequence: 12, applied: [10, 11, 12], duplicates: [11] },
  burst: { status: "FRESH", finalSequence: 51, applied: Array.from({ length: 51 }, (_, index) => index + 1), duplicates: [] },
  gap: { status: "UNKNOWN", reason: "GAP", applied: [10], duplicates: [] },
  "reordered-late": { status: "UNKNOWN", reason: "REORDERED", applied: [10, 11], duplicates: [] },
  "late-exact-duplicate": { status: "UNKNOWN", reason: "REORDERED", applied: [10, 11], duplicates: [] },
  "same-sequence-conflict": { status: "UNKNOWN", reason: "CONFLICT", applied: [10], duplicates: [] },
  "stream-mismatch": { status: "UNKNOWN", reason: "STREAM_MISMATCH", applied: [10], duplicates: [] },
  "delta-before-snapshot": { status: "UNKNOWN", reason: "DELTA_BEFORE_SNAPSHOT", applied: [], duplicates: [] }
});

const input = JSON.parse(readFileSync(0, "utf8"));
const result = expected[input.caseId];
if (result === undefined) throw new Error(`missing independent event oracle for ${input.caseId}`);
process.stdout.write(`${JSON.stringify(result)}\n`);
