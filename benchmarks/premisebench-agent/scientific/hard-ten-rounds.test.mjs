import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, roundPlan } from "./hard-ten-rounds.mjs";

test("twenty-round plan grows by 25 tasks every two rounds and is explicit", () => {
  assert.deepEqual(roundPlan.map((round) => round.number), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.deepEqual(roundPlan.map((round) => round.tasks), [
    200, 200, 225, 225, 250, 250, 275, 275, 300, 300,
    325, 325, 350, 350, 375, 375, 400, 400, 425, 425
  ]);
  assert.equal(roundPlan.length, 20);
  assert.equal(roundPlan.reduce((total, round) => total + round.tasks, 0), 6250);
  assert.ok(roundPlan.every((round) => round.volatility >= 0 && round.volatility <= 100));
});

test("orchestrator distinguishes live sampling from the deterministic cohort", () => {
  const defaults = parseArgs(["--skip-llm", "--llm-tasks=0"]);
  assert.equal(defaults.end, 20);

  const args = parseArgs(["--start=2", "--end=3", "--llm-tasks=4", "--skip-llm", "--output=.tmp/hard-test"]);
  assert.equal(args.start, 2);
  assert.equal(args.end, 3);
  assert.equal(args.llmTasks, 4);
  assert.equal(args.skipLlm, true);
  assert.equal(args.requireLive, false);
  assert.equal(args.provider, "gemini");
  assert.equal(args.model, "gemini-3.5-flash-lite");
  assert.equal(args.responseFormat, "json-object");
  assert.equal(parseArgs(["--response-format=none"]).responseFormat, "none");
  assert.throws(() => parseArgs(["--llm-tasks=301"]), /llm-tasks/iu);
});
