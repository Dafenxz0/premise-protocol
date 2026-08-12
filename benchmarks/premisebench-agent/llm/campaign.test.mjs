import assert from "node:assert/strict";
import test from "node:test";
import { blindReport, listedCost, parseAgentMessage, parseArgs, systemPrompt, visibleEnvelope } from "./campaign.mjs";

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

  const incomplete = blindReport(args, [result("basic", { tasks: 1 })], "sha256:tasks");
  assert.equal(incomplete.status, "NOT_COMPARABLE");
  assert.deepEqual(incomplete.results, []);
});

for (const status of ["RATE_LIMITED", "PAYMENT_REQUIRED", "NOT_RUN"]) {
  test(`LLM blind report never ranks a ${status} campaign`, () => {
    const blocked = blindReport(args, [result("basic"), result("premise", { status })], "sha256:tasks");
    assert.equal(blocked.status, "NOT_COMPARABLE");
    assert.deepEqual(blocked.results, []);
    assert.equal(Object.hasOwn(blocked, "winner"), false);
    assert.equal(Object.hasOwn(blocked, "ranking"), false);
  });
}

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

test("hard scenario is selectable without changing the blinded contract", () => {
  const hard = parseArgs([
    "--provider=gemini",
    "--model=gemini-test",
    "--tasks=2",
    "--scenario=hard",
    "--round=hard-test",
    "--arms=basic,premise"
  ]);
  assert.equal(hard.scenario, "hard");
  assert.equal(hard.tasks, 2);
});

test("OpenRouter/Nemotron settings are accepted without inline credentials", () => {
  const openrouter = parseArgs([
    "--provider=openrouter",
    "--model=nvidia/nemotron-3-ultra-550b-a55b",
    "--endpoint=https://openrouter.ai/api/v1/chat/completions",
    "--credential-env=OPENROUTER_API_KEY",
    "--max-tokens=1024",
    "--tasks=2",
    "--round=openrouter-test",
    "--arms=premise"
  ]);
  assert.equal(openrouter.provider, "openrouter");
  assert.equal(openrouter.endpoint, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(openrouter.credentialEnv, "OPENROUTER_API_KEY");
  assert.equal(openrouter.maxTokens, 1024);
});

test("free OpenRouter models can opt out of structured-output enforcement", () => {
  const openrouter = parseArgs([
    "--provider=openrouter",
    "--model=inclusionai/ling-3.0-tiny:free",
    "--response-format=none",
    "--tasks=1",
    "--round=openrouter-free-test",
    "--arms=premise"
  ]);
  assert.equal(openrouter.responseFormat, "none");
});

test("OpenRouter live guard exposes a bounded request budget and interval", () => {
  const guarded = parseArgs([
    "--provider=openrouter",
    "--model=inclusionai/ling-3.0-tiny:free",
    "--tasks=2",
    "--max-turns=4",
    "--max-provider-requests=36",
    "--min-request-interval-ms=4000",
    "--max-provider-tokens=24000",
    "--max-retries=0",
    "--round=ling-guard-test"
  ]);
  assert.equal(guarded.maxTurns, 4);
  assert.equal(guarded.maxProviderRequests, 36);
  assert.equal(guarded.minRequestIntervalMs, 4000);
  assert.equal(guarded.maxProviderTokens, 24000);
  assert.throws(() => parseArgs([
    "--provider=openrouter",
    "--model=inclusionai/ling-3.0-tiny:free",
    "--max-provider-requests=1",
    "--max-retries=1"
  ]), /max-retries must be 0/iu);
});

test("listed OpenRouter price is calculated only from complete usage", () => {
  const pricing = { status: "OK", pricing: { prompt: 0, completion: 0, request: 0 } };
  assert.equal(listedCost({ inputTokens: 20, outputTokens: 5, completionRequests: 2, cachedTokens: 0, usageStatus: "COMPLETE" }, pricing), 0);
  assert.equal(listedCost({ inputTokens: 20, outputTokens: 5, completionRequests: 2, cachedTokens: 0, usageStatus: "PARTIAL_OR_UNKNOWN" }, pricing), null);
});

test("arms cannot silently borrow another arm's write capability", () => {
  const guarded = JSON.stringify({ type: "actIfVersion", expectedVersion: "sha256:v1", action: { kind: "apply", value: "safe" } });
  assert.throws(() => parseAgentMessage(guarded, "basic"), /not allowed/iu);
  assert.throws(() => parseAgentMessage(JSON.stringify({ type: "act", action: { kind: "apply", value: "safe" } }), "premise"), /not allowed/iu);
  assert.deepEqual(parseAgentMessage(guarded, "premise"), { type: "actIfVersion", expectedVersion: "sha256:v1", action: { kind: "apply", value: "safe" } });
});
