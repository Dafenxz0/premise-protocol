import assert from "node:assert/strict";
import test from "node:test";
import { blindReport, parseArgs, systemPrompt, visibleEnvelope } from "./campaign.mjs";

const args = parseArgs([
  "--provider=gemini",
  "--model=gemini-test",
  "--tasks=2",
  "--seed=7",
  "--round=blind-test",
  "--arms=basic,premise"
]);

function result(arm, overrides = {}) {
  return {
    arm,
    name: arm,
    status: "OK",
    tasks: 2,
    completed: 2,
    completedRate: 100,
    unsafeActions: 0,
    unsafeRate: 0,
    falseBlocks: 0,
    actionAttempts: 2,
    completionRequests: 2,
    externalReads: 0,
    providerCost: null,
    ...overrides
  };
}

test("LLM blind report removes arm identity and refuses partial campaigns", () => {
  const blind = blindReport(args, [result("basic"), result("premise")], "sha256:tasks");
  assert.equal(blind.status, "READY_FOR_EXAMINER");
  assert.equal(blind.results.length, 2);
  assert.notEqual(blind.results[0].id, "basic");
  assert.equal(Object.hasOwn(blind.results[0], "arm"), false);
  assert.equal(Object.hasOwn(blind.results[0].metrics, "name"), false);

  const blocked = blindReport(args, [result("basic"), result("premise", { status: "ERROR" })], "sha256:tasks");
  assert.equal(blocked.status, "NOT_COMPARABLE");
  assert.deepEqual(blocked.results, []);
});

test("agent input omits the arm identity while retaining only assigned semantics", () => {
  const prompt = systemPrompt("premise");
  assert.doesNotMatch(prompt, /PREMiSE|Smart Revalidate|Basic memory|Conventional revalidation/iu);
  const local = { count: 0 };
  const envelope = visibleEnvelope({
    task: { taskId: "task-1", prompt: "act safely", source: "filesystem:config.json" },
    memory: { version: "sha256:v1", content: { status: "active", value: "safe" } },
    arm: "premise",
    world: { mutationEvent: null },
    local
  });
  assert.equal(Object.hasOwn(envelope, "policy"), false);
  assert.equal(envelope.localCheck.state, "FRESH");
});
