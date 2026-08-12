import assert from "node:assert/strict";
import test from "node:test";
import {
  HARD_KINDS,
  HARD_SCENARIO_KINDS,
  RISK_LEVELS,
  VOLATILITY_LEVELS,
  WORLD_KINDS,
  hardDatasetManifest,
  makeHardTasks,
  publicHardTask
} from "./hard-scenarios.mjs";

const FORBIDDEN = /^(?:accepted|agentInput|after|decision|domain|event|events|evaluator|expected|family|final|finalSource|groundTruth|hardCase|kind|label|labels|mutation|mutationWindow|mutations|objective|oracle|outcome|planned|scheduled|terminal|volatility|winner|world)$/iu;

function assertNoOracle(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoOracle(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(FORBIDDEN.test(key), false, `${path}.${key} crossed the agent boundary`);
    assertNoOracle(child, `${path}.${key}`);
  }
}

test("hard tasks are deterministic and cover the difficult control surface", () => {
  const first = makeHardTasks(240, 20260811);
  const second = makeHardTasks(240, 20260811);
  assert.deepEqual(first, second);
  assert.ok(new Set(first.map((task) => task.hardCase.kind)).size >= 15);
  assert.ok(HARD_SCENARIO_KINDS.every((kind) => first.some((task) => task.hardCase.kind === kind)));
  assert.deepEqual(new Set(first.map((task) => task.domain)), new Set(WORLD_KINDS));
  assert.deepEqual(new Set(first.map((task) => task.risk)), new Set(RISK_LEVELS));
  assert.ok(first.some((task) => task.mutationWindow === "during-write"));
  assert.ok(first.some((task) => task.initial.value.length > 1000));
  assert.ok(first.filter((task) => task.hardCase.kind === "giant-context").length >= 8);
  assert.ok(HARD_KINDS.includes(first[0].hardCase.kind));
});

test("private controls include dependencies, event races, writers and local world specs", () => {
  const tasks = makeHardTasks({ count: 240, seed: "hard-controls", volatility: 100 });
  const byKind = new Map(tasks.map((task) => [task.hardCase.kind, task]));
  assert.ok(byKind.get("dependency-fan-in").dependencies.length >= 2);
  assert.ok(byKind.get("dependency-fan-out").hardCase.fanOut >= 2);
  assert.equal(byKind.get("aba").hardCase.sameContentAtEnd, true);
  assert.equal(byKind.get("lost-event").hardCase.delivery, "lost");
  assert.equal(byKind.get("out-of-order-event").hardCase.delivery, "late");
  assert.equal(byKind.get("concurrent-writers").hardCase.writerCount >= 2, true);
  assert.equal(byKind.get("partial-write").hardCase.complete, false);
  assert.equal(byKind.get("timeout").hardCase.transport, "timeout");
  assert.ok(byKind.get("dependency-fan-in").agentInput.memory.content.dependencies.length >= 4);
  assert.ok(tasks.every((task) => task.agentInput.memory.dependencies.length >= 2));
  const connectorPayload = JSON.parse(byKind.get("giant-context").initial.value);
  assert.equal(connectorPayload.protocol, "connector-snapshot/v1");
  assert.equal(connectorPayload.connector, `${byKind.get("giant-context").world}-like`);
  assert.equal(connectorPayload.records.length, 257);
  assert.equal(connectorPayload.records.some((record) => record.role === "requested"), true);
  assert.equal(connectorPayload.records.filter((record) => record.role === "d").length, 256);
  assert.ok(tasks.every((task) => task.initial.dependencies.every((dependency) => Object.keys(dependency).sort().join(",") === "source,version")));
  assert.ok(tasks.every((task) => task.agentInput.memory.dependencies.every((dependency) => Object.hasOwn(dependency, "content"))));
  assert.ok(tasks.every((task) => task.worldSpec.mode === "local" && task.worldSpec.network === false));
  assert.deepEqual(new Set(tasks.map((task) => task.worldSpec.kind)), new Set([
    "filesystem-like", "git-like", "postgres-like", "calendar-like"
  ]));
});

test("hard LLM envelopes stay bounded without removing the adversarial controls", () => {
  const tasks = makeHardTasks({ count: 40, seed: 20260811, volatility: 25 });
  const maxInitialBytes = Math.max(...tasks.map((task) => Buffer.byteLength(JSON.stringify(task.initial), "utf8")));
  const maxBytes = Math.max(...tasks.map((task) => Buffer.byteLength(JSON.stringify(task.agentInput), "utf8")));
  const giant = tasks.find((task) => task.hardCase.kind === "giant-context");
  assert.ok(giant);
  assert.ok(maxInitialBytes < 20_000, `LLM start snapshot unexpectedly large: ${maxInitialBytes} bytes`);
  assert.ok(maxBytes < 30_000, `public hard context unexpectedly large: ${maxBytes} bytes`);
  assert.ok(giant.mutationWindow !== undefined);
  assert.ok(giant.dependencies.length >= 2);
  assert.ok(giant.hardCase.control.eventCount >= 1);
  assert.equal(Object.hasOwn(giant.agentInput, "mutation"), false);
  assert.equal(Object.hasOwn(giant.agentInput, "evaluator"), false);
});

test("agentInput and public manifests contain no evaluator oracle", () => {
  const tasks = makeHardTasks({ count: 20, seed: 7, volatility: 50 });
  for (const task of tasks) {
    assertNoOracle(task.agentInput);
    assert.deepEqual(Object.keys(task.agentInput).sort(), ["memory", "prompt", "risk", "source", "taskId", "tools"]);
    assert.equal(Object.hasOwn(task.agentInput.memory, "mutation"), false);
    assert.equal(Object.hasOwn(task.agentInput.memory, "final"), false);
    assert.deepEqual(publicHardTask(task), task.agentInput);
  }
  const manifest = hardDatasetManifest(tasks);
  assertNoOracle(manifest.tasks);
  assert.equal(manifest.taskCount, tasks.length);
  assert.equal(manifest.taskSetHash, hardDatasetManifest(tasks).taskSetHash);
  assert.equal(JSON.stringify(manifest).match(/"(?:mutation|labels?|oracle|expected|outcome|groundTruth)"\s*:/iu), null);
  assert.throws(() => publicHardTask({
    agentInput: {
      ...tasks[0].agentInput,
      memory: { ...tasks[0].agentInput.memory, final: { status: "blocked" } }
    }
  }), /private hard-scenario field/iu);
});

test("risk is public policy input while the mutation schedule remains private", () => {
  const low = makeHardTasks({ count: 240, seed: 91, volatility: 50, risk: "low", worlds: ["filesystem"] });
  const critical = makeHardTasks({ count: 240, seed: 91, volatility: 50, risk: "critical", worlds: ["filesystem"] });
  assert.ok(critical.filter((task) => task.mutationWindow !== "none").length > low.filter((task) => task.mutationWindow !== "none").length);
  const withoutRisk = (agentInput) => { const { risk: _risk, ...rest } = agentInput; return rest; };
  assert.deepEqual(low.map(({ agentInput }) => withoutRisk(agentInput)), critical.map(({ agentInput }) => withoutRisk(agentInput)));
  assert.ok(low.every(({ agentInput }) => agentInput.risk === "low"));
  assert.ok(critical.every(({ agentInput }) => agentInput.risk === "critical"));
  assert.ok(low.every(({ agentInput }) => JSON.stringify(agentInput).match(/"(?:volatility|world|domain)"\s*:/iu) === null));
});

test("volatility is deterministic and zero means no scheduled mutation", () => {
  const stable = makeHardTasks({ count: 100, seed: 42, volatility: 0, worlds: ["filesystem"] });
  const volatile = makeHardTasks({ count: 100, seed: 42, volatility: 100, worlds: ["filesystem"] });
  assert.ok(stable.every((task) => task.mutationWindow === "none"));
  assert.ok(volatile.some((task) => task.mutationWindow !== "none"));
  assert.notDeepEqual(stable.map(({ mutationWindow }) => mutationWindow), volatile.map(({ mutationWindow }) => mutationWindow));
  assert.deepEqual(
    stable.map(({ taskId, prompt, source, agentInput }) => ({ taskId, prompt, source, agentInput })),
    makeHardTasks({ count: 100, seed: 42, volatility: 0, worlds: ["filesystem"] })
      .map(({ taskId, prompt, source, agentInput }) => ({ taskId, prompt, source, agentInput }))
  );
  assert.deepEqual(VOLATILITY_LEVELS, [0, 1, 5, 10, 25, 50]);
});

test("supports aliases, datasets and rejects invalid dimensions", () => {
  const tasks = makeHardTasks({ count: 4, seed: 1, risk: "CRITICAL", volatility: "25%", worlds: ["filesystem-like", "git-like", "postgres-like", "calendar-like"] });
  assert.deepEqual(new Set(tasks.map((task) => task.risk)), new Set(["critical"]));
  assert.deepEqual(new Set(tasks.map((task) => task.volatility)), new Set([25]));
  assert.deepEqual(new Set(tasks.map((task) => task.domain)), new Set(WORLD_KINDS));
  assert.throws(() => makeHardTasks({ count: 0 }), /count/iu);
  assert.throws(() => makeHardTasks({ count: 1, risk: "urgent" }), /risk/iu);
  assert.throws(() => makeHardTasks({ count: 1, volatility: 101 }), /volatility/iu);
  assert.throws(() => makeHardTasks({ count: 1, world: "remote" }), /world/iu);
});
