import { readFileSync } from "node:fs";

// Independent invariant oracle. It does not import runtime-core or the
// benchmark runner and never receives implementation labels.
const input = JSON.parse(readFileSync(0, "utf8"));
const { steps, worldSize, observed } = input;
const expectedEvents = worldSize * 2 + steps * 3 - 1;
const expectedDecisions = steps * 2 + (steps - Math.floor(steps / 29)) + Math.floor(steps / 17);
const expectedEventTypeCounts = {
  MemoryRegistered: 1,
  MemoryDerived: worldSize - 1,
  SourceChanged: steps,
  MemoryStaled: worldSize + steps - 1,
  MemoryRevalidated: steps - Math.floor(steps / 29),
  MemoryReplaced: Math.floor(steps / 29)
};
const expectedFirstEvents = ["MemoryRegistered", ...Array.from({ length: Math.min(worldSize - 1, 2) }, () => "MemoryDerived")];
const expectedLastEvent = steps % 29 === 0 ? "MemoryReplaced" : "MemoryRevalidated";
const checks = {
  horizon: observed.horizonSteps === steps,
  activeRecords: observed.activeRecords === worldSize,
  eventCount: observed.eventCount === expectedEvents,
  decisionEvents: observed.decisionEvents === expectedDecisions,
  eventTypes: JSON.stringify(observed.eventTypeCounts) === JSON.stringify(expectedEventTypeCounts),
  eventBoundary: JSON.stringify(observed.eventBoundary.first) === JSON.stringify(expectedFirstEvents)
    && observed.eventBoundary.last.at(-1) === expectedLastEvent,
  noRuntimeErrors: observed.runtimeErrors === 0,
  noFrontierErrors: observed.frontierErrors === 0,
  runtimeFrontierComplete: observed.runtimeFrontierComplete === true && observed.frontierComplete === true,
  receiptBounded: observed.receiptEntries <= 1 && observed.cacheProbe.receiptEntries === Math.min(steps, 128),
  receiptEvictions: observed.cacheProbe.receiptEvictions === Math.max(0, steps - 128),
  negativeCacheProbeObserved: observed.cacheProbe.negativeCacheEntries === steps,
  frontierProbe: observed.frontierCacheProbe.errors === 0
    && observed.frontierCacheProbe.beforeCleanup.tombstonedRootCount === worldSize
    && observed.frontierCacheProbe.beforeCleanup.tombstonedRootEntries === worldSize * 2
    && observed.frontierCacheProbe.afterLeafQueries.tombstonedRootEntries === worldSize
    && observed.frontierCacheProbe.afterCleanup.tombstonedRootCount === 0
    && observed.frontierCacheProbe.afterCleanup.tombstonedRootEntries === 0
    && observed.frontierCacheProbe.afterCleanup.trusted === true
};
process.stdout.write(`${JSON.stringify({
  expectedEvents,
  expectedDecisions,
  expectedEventTypeCounts,
  checks,
  pass: Object.values(checks).every(Boolean)
})}\n`);
