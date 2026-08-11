import assert from "node:assert/strict";
import test from "node:test";
import {
  MUTATION_KINDS,
  assertMetamorphicChecks,
  createPublicManifest,
  generateDataset,
  generateScenarios,
  hashDataset,
  runMetamorphicChecks,
  toAgentInput
} from "./adversarial.mjs";

const forbiddenKey = /^(?:label|labels|mutation|mutations|oracle|groundTruth|expected|outcome|objective)$/iu;

function assertNoForbiddenKeys(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbiddenKey.test(key), false, `${path}.${key} crosses the agent boundary`);
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

test("scientific generator is reproducible and covers every requested adversarial kind", () => {
  const first = generateScenarios({ count: MUTATION_KINDS.length * 2, seed: 20260811 });
  const second = generateScenarios({ count: MUTATION_KINDS.length * 2, seed: 20260811 });
  assert.deepEqual(first, second);
  assert.deepEqual(new Set(first.map((scenario) => scenario.mutation.kind)), new Set(MUTATION_KINDS));
  assert.equal(new Set(first.map((scenario) => scenario.taskId)).size, first.length);
  assert.ok(first.every((scenario) => typeof scenario.seed === "string" && scenario.seed.startsWith("sha256:")));
});

test("agent input and public manifest do not expose evaluator fields", () => {
  const dataset = generateDataset({ count: 20, seed: "scientific-test" });
  assertNoForbiddenKeys(dataset.scenarios.map(toAgentInput));
  const manifest = createPublicManifest(dataset);
  assertNoForbiddenKeys(manifest);
  assert.equal(manifest.datasetHash, dataset.datasetHash);
  assert.equal(JSON.stringify(manifest).match(/"(?:mutation|labels?|oracle|expected|outcome|groundTruth)"\s*:/iu), null);
  assert.equal(manifest.tasks.length, 20);
});

test("public hash is reproducible, seed-sensitive, and prefix-stable", () => {
  const dataset = generateDataset({ count: 9, seed: 7 });
  const larger = generateScenarios({ count: 10, seed: 7 });
  assert.equal(dataset.datasetHash, hashDataset(dataset.tasks));
  assert.equal(dataset.datasetHash, hashDataset(larger.slice(0, 9)));
  assert.notEqual(dataset.datasetHash, generateDataset({ count: 9, seed: 8 }).datasetHash);
});

test("metamorphic checks report success", () => {
  const result = runMetamorphicChecks({ count: MUTATION_KINDS.length + 3, seed: 99 });
  assert.equal(result.ok, true, result.failures.join(", "));
  assert.deepEqual(result.failures, []);
  assert.equal(assertMetamorphicChecks({ count: 5, seed: "checks" }).ok, true);
});

test("each requested kind has a private deterministic control and public observation", () => {
  const scenarios = generateScenarios({ count: MUTATION_KINDS.length, seed: "kinds" });
  for (const scenario of scenarios) {
    assert.ok(scenario.mutation.events.length > 0, `${scenario.mutation.kind} has no event`);
    assert.equal(scenario.agentInput.taskId, scenario.taskId);
    assert.deepEqual(toAgentInput(scenario), scenario.agentInput);
  }
  const writers = scenarios.find((scenario) => scenario.mutation.kind === "concurrent-writers").mutation.writerCount;
  assert.ok([2, 3].includes(writers));
});
