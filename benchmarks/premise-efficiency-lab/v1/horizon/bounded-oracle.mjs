import { readFileSync } from "node:fs";

function valid(input) {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

export function evaluateBoundedHorizon(input) {
  const value = valid(input) ? input : {};
  const observed = valid(value.observed) ? value.observed : {};
  const steps = value.steps;
  const tailSize = value.tailSize;
  const worldSize = value.worldSize;
  const checks = {
    validInput: Number.isSafeInteger(steps) && steps >= 1 && Number.isSafeInteger(tailSize) && tailSize >= 1 && Number.isSafeInteger(worldSize) && worldSize >= 2,
    auditPreserved: observed.auditEntries === steps,
    activeRecordsPreserved: observed.records === worldSize,
    eventTailBounded: observed.peakEventTail <= tailSize && observed.finalEventTail <= tailSize,
    idempotencyTailBounded: observed.peakIdempotencyKeys <= tailSize && observed.finalIdempotencyKeys <= tailSize,
    checkpointsCompleted: observed.checkpoints >= 1,
    noRuntimeErrors: observed.errors === 0
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

if (process.argv[1] && process.argv[1].endsWith("bounded-oracle.mjs")) {
  const result = evaluateBoundedHorizon(JSON.parse(readFileSync(0, "utf8")));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
