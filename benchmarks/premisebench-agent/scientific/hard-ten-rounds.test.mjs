import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, roundPlan } from "./hard-ten-rounds.mjs";

test("ten-round plan grows 200,200,225...300 and is explicit", () => {
  assert.deepEqual(roundPlan.map((round) => round.tasks), [200, 200, 225, 225, 250, 250, 275, 275, 300, 300]);
  assert.equal(roundPlan.length, 10);
  assert.ok(roundPlan.every((round) => round.volatility >= 0 && round.volatility <= 100));
});

test("orchestrator distinguishes live sampling from the deterministic cohort", () => {
  const args = parseArgs(["--start=2", "--end=3", "--llm-tasks=4", "--skip-llm", "--output=.tmp/hard-test"]);
  assert.equal(args.start, 2);
  assert.equal(args.end, 3);
  assert.equal(args.llmTasks, 4);
  assert.equal(args.skipLlm, true);
  assert.equal(args.requireLive, false);
});
