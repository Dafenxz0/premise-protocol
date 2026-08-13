import { readFileSync } from "node:fs";

// This process deliberately has no runtime or benchmark imports. It is the
// expected-count oracle for the deterministic receipt campaign.
const expected = Object.freeze({
  "sequential-completed-reuse": ({ recordCount }) => ({ baseline: recordCount * 2, candidate: 1, status: "FRESH" }),
  "concurrent-stampede": () => ({ baseline: 1, candidate: 1, status: "FRESH" }),
  "authorization-isolation": ({ recordCount }) => ({ baseline: recordCount, candidate: 2, status: "FRESH" }),
  "scope-matrix": ({ recordCount, uniqueScopes }) => ({ baseline: recordCount, candidate: uniqueScopes, status: "FRESH" }),
  "tenant-isolation": () => ({ baseline: 2, candidate: 2, status: "FRESH" }),
  "incomplete-scope": ({ recordCount }) => ({ baseline: recordCount * 2, candidate: recordCount * 2, status: "FRESH" }),
  "source-rotation": ({ recordCount }) => ({ baseline: recordCount * 2, candidate: recordCount + 1, status: "INVALID" }),
  "expiry": ({ recordCount }) => ({ baseline: recordCount * 2, candidate: 2, status: "FRESH" }),
  "failure-not-cached": () => ({ baseline: 2, candidate: 2, status: "FRESH" }),
  "in-flight-invalidation-fence": () => ({ baseline: 1, candidate: 1, status: "STALE" })
});

const input = JSON.parse(readFileSync(0, "utf8"));
const makeExpected = expected[input.scenarioId];
if (makeExpected === undefined) throw new Error(`missing independent receipt oracle for ${input.scenarioId}`);
process.stdout.write(`${JSON.stringify(makeExpected(input))}\n`);
