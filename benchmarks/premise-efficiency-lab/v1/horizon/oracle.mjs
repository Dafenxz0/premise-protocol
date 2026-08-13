import { readFileSync } from "node:fs";

// Independent invariant oracle. It does not import runtime-core or the
// benchmark runner and never receives implementation labels.
const input = JSON.parse(readFileSync(0, "utf8"));
const { steps, worldSize, observed } = input;
const expectedEvents = worldSize * 2 + steps * 3 - 1;
const minimumDecisions = steps * 3;
const checks = {
  horizon: observed.horizonSteps === steps,
  activeRecords: observed.activeRecords === worldSize,
  eventCount: observed.eventCount === expectedEvents,
  decisionEvents: observed.decisionEvents >= minimumDecisions,
  noRuntimeErrors: observed.runtimeErrors === 0,
  noFrontierErrors: observed.frontierErrors === 0,
  receiptBounded: observed.receiptEntries <= 1,
  negativeCacheBounded: observed.negativeCacheEntries <= 1
};
process.stdout.write(`${JSON.stringify({
  expectedEvents,
  minimumDecisions,
  checks,
  pass: Object.values(checks).every(Boolean)
})}\n`);
