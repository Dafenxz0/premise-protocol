import assert from "node:assert/strict";
import test from "node:test";
import { makeMatrixTasks } from "./matrix.mjs";
import { RISK_LEVELS, VOLATILITY_LEVELS, WORLD_KINDS } from "./campaigns.mjs";

test("matrix generator covers volatility and risk without exposing evaluator fields", () => {
  const tasks = makeMatrixTasks({ tasksPerCell: 2, seed: 41 });
  assert.equal(tasks.length, VOLATILITY_LEVELS.length * RISK_LEVELS.length * WORLD_KINDS.length * 2);
  assert.deepEqual(new Set(tasks.map((task) => task.volatility)), new Set(VOLATILITY_LEVELS));
  assert.deepEqual(new Set(tasks.map((task) => task.risk)), new Set(RISK_LEVELS));
  for (const task of tasks) {
    assert.equal(Object.hasOwn(task, "oracle"), false);
    assert.equal(Object.hasOwn(task, "expected"), false);
    assert.equal(Object.hasOwn(task, "outcome"), false);
    assert.equal(Object.hasOwn(task.initial, "status"), true);
  }
});

test("zero volatility produces no world mutation schedule", () => {
  const tasks = makeMatrixTasks({ tasksPerCell: 20, seed: 42, volatilityLevels: [0], riskLevels: ["low"] });
  assert.ok(tasks.every((task) => task.mutationWindow === "none"));
});
