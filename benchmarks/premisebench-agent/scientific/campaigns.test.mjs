import assert from "node:assert/strict";
import test from "node:test";
import {
  createPublicManifest,
  generateCampaign,
  generateCampaigns,
  hashDataset,
  RISK_LEVELS,
  toAgentInput,
  VOLATILITY_LEVELS,
  WORLD_KINDS
} from "./campaigns.mjs";

const FORBIDDEN = /^(?:mutation|mutationWindow|objective|expected|outcome|oracle|groundTruth|family|labels?)$/iu;

function assertNoOracle(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoOracle(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(FORBIDDEN.test(key), false, `${path}.${key} crosses the agent boundary`);
    assertNoOracle(child, `${path}.${key}`);
  }
}

test("exports the preregistered campaign dimensions", () => {
  assert.deepEqual(VOLATILITY_LEVELS, [0, 1, 5, 10, 25, 50]);
  assert.deepEqual(RISK_LEVELS, ["low", "medium", "high", "critical"]);
  assert.deepEqual(WORLD_KINDS, ["filesystem", "git-like"]);
});

test("generates the full deterministic 6 x 4 x 2 matrix", () => {
  const campaigns = generateCampaigns({ seed: 7, tasksPerCampaign: 12 });
  assert.equal(campaigns.length, 48);
  assert.deepEqual(
    new Set(campaigns.map(({ volatility }) => volatility)),
    new Set(VOLATILITY_LEVELS)
  );
  assert.deepEqual(new Set(campaigns.map(({ risk }) => risk)), new Set(RISK_LEVELS));
  assert.deepEqual(new Set(campaigns.map(({ world }) => world)), new Set(WORLD_KINDS));
  assert.equal(new Set(campaigns.map(({ campaignId }) => campaignId)).size, campaigns.length);
});

test("is deterministic and JSON round-trippable", () => {
  const options = { seed: 20260811, taskCount: 25, volatility: "25%", risk: "HIGH", world: "git" };
  const first = generateCampaign(options);
  const second = generateCampaign(options);
  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.equal(first.worldSpec.mode, "local");
  assert.equal(first.worldSpec.network, false);
  assert.equal(first.worldSpec.branch, "main");
  assert.equal(first.taskSetHash, hashDataset(first));
  assert.deepEqual(createPublicManifest(first), first.publicManifest);
});

test("volatility changes the deterministic schedule without changing visible task identity", () => {
  const stable = generateCampaign({ seed: 11, taskCount: 100, volatility: 0, risk: "low", world: "filesystem" });
  const volatile = generateCampaign({ seed: 11, taskCount: 100, volatility: 50, risk: "low", world: "filesystem" });
  assert.equal(stable.tasks.length, volatile.tasks.length);
  assert.deepEqual(
    stable.tasks.map(({ taskId, prompt, source, memory }) => ({ taskId, prompt, source, memory })),
    volatile.tasks.map(({ taskId, prompt, source, memory }) => ({ taskId, prompt, source, memory }))
  );
  assert.notEqual(stable.campaignId, volatile.campaignId);
  assert.equal(stable.volatility, 0);
  assert.equal(volatile.volatility, 50);
});

test("agent input contains only public task data and no oracle fields", () => {
  const campaign = generateCampaign({ seed: 42, taskCount: 5, volatility: 50, risk: "critical", world: "filesystem" });
  assertNoOracle(campaign.agent);
  assertNoOracle(campaign.publicManifest);
  assert.deepEqual(campaign.agent.tasks, campaign.tasks);
  assert.equal(campaign.scenarios.length, campaign.taskCount);
  assert.ok(campaign.scenarios.some(({ evaluator }) => evaluator.scheduled));
  assert.deepEqual(toAgentInput(campaign.scenarios[0]), campaign.agent.tasks[0]);
  for (const task of campaign.agent.tasks) {
    assert.deepEqual(Object.keys(task).sort(), ["memory", "prompt", "source", "taskId", "tools"]);
    assert.deepEqual(task.tools, ["check", "read", "act", "actIfVersion"]);
    assert.equal(task.memory.content.status, "active");
    assert.equal(typeof task.memory.version, "string");
  }
});

test("volatile scenarios use the exact deterministic mutation count privately", () => {
  for (const volatility of VOLATILITY_LEVELS) {
    const campaign = generateCampaign({ seed: 3, taskCount: 100, volatility, risk: "medium", world: "filesystem" });
    const scheduled = campaign.scenarios.filter(({ evaluator }) => evaluator.scheduled).length;
    assert.equal(scheduled, volatility);
  }
});

test("supports small selected matrices and rejects invalid dimensions", () => {
  const selected = generateCampaigns({
    seed: 1,
    taskCount: 2,
    volatilities: [0, 50],
    risks: ["low", "critical"],
    worlds: ["filesystem"]
  });
  assert.equal(selected.length, 4);
  assert.throws(() => generateCampaign({ volatility: 2 }), /volatility/iu);
  assert.throws(() => generateCampaign({ risk: "urgent" }), /risk/iu);
  assert.throws(() => generateCampaign({ world: "remote-git" }), /world/iu);
  assert.throws(() => generateCampaigns({ worlds: ["filesystem", "fs"] }), /duplicates/iu);
});
