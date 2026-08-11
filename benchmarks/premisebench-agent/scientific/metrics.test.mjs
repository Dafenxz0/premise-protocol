import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateByPolicy,
  costPerSafeAttempt,
  costPerSafeSuccessfulTask,
  deriveCost,
  idealOracleLowerBound,
  mdeForProportionDifference,
  mdeForRelativeCost,
  powerForProportionDifference,
  powerForRelativeCost,
  safeCompletionRate,
  safeAttempt,
  safeSuccessfulTask,
  summarizeSafeEfficiency,
  unsafeActionRate,
  wastedWork
} from "./metrics.mjs";

const proxyRows = [
  { policy: "A", taskId: "t1", attempted: true, safe: true, unsafeAction: false, success: true, costProxyUsd: 1 },
  { policy: "A", taskId: "t2", attempted: true, safe: true, unsafeAction: false, success: false, costProxyUsd: 2 },
  { policy: "A", taskId: "t3", attempted: true, safe: false, unsafeAction: true, success: false, costProxyUsd: 3 }
];

test("summarizeSafeEfficiency defines safe completion and unsafe action rates", () => {
  const summary = summarizeSafeEfficiency(proxyRows);
  assert.equal(summary.tasks, 3);
  assert.equal(summary.attempts, 3);
  assert.equal(summary.safeAttempts, 2);
  assert.equal(summary.safeSuccessfulTasks, 1);
  assert.ok(Math.abs(summary.safeCompletionRate - (100 / 3)) < 1e-12);
  assert.equal(summary.safeCompletionRateFraction, 1 / 3);
  assert.equal(summary.unsafeActions, 1);
  assert.ok(Math.abs(summary.unsafeActionRate - (100 / 3)) < 1e-12);
  assert.equal(summary.unsafeActionRateFraction, 1 / 3);
  assert.equal(summary.costBasis, "proxy");
  assert.equal(summary.totalCostUsd, 6);
  assert.equal(summary.costPerSafeAttemptUsd, 3);
  assert.equal(summary.costPerSafeSuccessfulTaskUsd, 6);
  assert.equal(summary.csfaUsd, 6);
  assert.deepEqual(summary.wastedWork, {
    attempts: 3,
    safeAttempts: 2,
    wastedAttempts: 2,
    wastedAttemptRate: 2 / 3,
    tasks: 3,
    safeSuccessfulTasks: 1,
    wastedTasks: 2,
    taskRate: 2 / 3,
    costBasis: "proxy",
    costUsd: 5,
    costShare: 5 / 6
  });
});

test("safe attempt and safe successful task are evaluator predicates", () => {
  assert.equal(safeAttempt(proxyRows[0]), true);
  assert.equal(safeAttempt(proxyRows[2]), false);
  assert.equal(safeSuccessfulTask(proxyRows[0]), true);
  assert.equal(safeSuccessfulTask(proxyRows[1]), false);
  assert.equal(safeAttempt({ attempts: [{ safe: true, unsafeAction: false }, { safe: false, unsafeAction: true }] }), false);
  assert.equal(safeSuccessfulTask({ attempts: [{ safe: true, unsafeAction: false }], completed: true }), true);
  assert.equal(safeCompletionRate(proxyRows, { rateScale: "fraction" }), 1 / 3);
  assert.equal(unsafeActionRate(proxyRows, { rateScale: "fraction" }), 1 / 3);
});

test("existing mutation traces use safeAttempt, completed and an explicitly selected proxy field", () => {
  const summary = summarizeSafeEfficiency([
    { taskId: "a", actionAttempted: true, safeAttempt: true, unsafeAction: false, completed: true, agentVisibleCostProxy: 1, connectorRequests: 2, externalReads: 1 },
    { taskId: "b", actionAttempted: true, safeAttempt: true, unsafeAction: false, completed: false, agentVisibleCostProxy: 2, connectorRequests: 3, externalReads: 2 },
    { taskId: "c", actionAttempted: false, safeAttempt: false, unsafeAction: false, completed: false, agentVisibleCostProxy: 3, connectorRequests: 0, externalReads: 0 }
  ], { proxyField: "agentVisibleCostProxy", proxyDeclared: true, costMode: "synthetic-proxy" });
  assert.ok(Math.abs(summary.safeCompletionRate - (100 / 3)) < 1e-12);
  assert.equal(summary.safeAttempts, 2);
  assert.equal(summary.unsafeActionRate, 0);
  assert.equal(summary.csfaUsd, 6);
  assert.equal(summary.connectorRequestsPer100, 500 / 3);
  assert.equal(summary.externalReadsPer100, 100);
});

test("deriveCost prefers real billing and only accepts declared proxy cost", () => {
  assert.deepEqual(deriveCost({ providerCostUsd: 0.25, totalCostUsd: 0.4, costProxyUsd: 99 }).basis, "real");
  assert.equal(deriveCost({ providerCostUsd: 0.25, totalCostUsd: 0.4, costProxyUsd: 99 }).amountUsd, 0.25);
  assert.equal(deriveCost({ totalCostUsd: 0.4 }).amountUsd, 0.4);
  assert.equal(deriveCost({ costProxyUsd: 0.12 }).amountUsd, 0.12);
  assert.equal(deriveCost({ costUsd: 0.12 }).amountUsd, null);
  assert.equal(deriveCost({ costUsd: 0.12, costBasis: "proxy" }).amountUsd, 0.12);
  assert.equal(deriveCost({ costUsd: 0.12 }, { proxyField: "costUsd" }).basis, "proxy");
});

test("cost metrics return null for incomplete telemetry and reject mixed bases", () => {
  const incomplete = summarizeSafeEfficiency([{ safe: true, success: true, costProxyUsd: 1 }, { safe: true, success: true }]);
  assert.equal(incomplete.costBasis, "proxy");
  assert.equal(incomplete.costCoverage, 1 / 2);
  assert.equal(incomplete.totalCostUsd, null);
  assert.equal(costPerSafeAttempt([{ safe: true, success: true }]), null);
  assert.equal(costPerSafeSuccessfulTask([{ safe: true, success: true }]), null);
  assert.equal(wastedWork([{ safe: true, success: true }]).costUsd, null);
  assert.throws(
    () => summarizeSafeEfficiency([{ safe: true, success: true, providerCostUsd: 1 }, { safe: true, success: true, costProxyUsd: 1 }]),
    /cannot be mixed/
  );
});

test("aggregateByPolicy is deterministic and does not add oracle bounds", () => {
  const rows = [
    { policy: "B", taskId: "b", safe: true, success: true, providerCostUsd: 2 },
    { policy: "A", taskId: "a", safe: true, success: false, providerCostUsd: 3 },
    { policy: "B", taskId: "b2", safe: true, success: true, providerCostUsd: 1 }
  ];
  const result = aggregateByPolicy(rows);
  assert.deepEqual(Object.keys(result), ["A", "B"]);
  assert.equal(result.A.policy, "A");
  assert.equal(result.B.totalCostUsd, 3);
  assert.throws(
    () => aggregateByPolicy([{ policy: "oracle", evaluatorOnly: true }]),
    /not policy candidates/
  );
  assert.throws(
    () => aggregateByPolicy([
      { policy: "A", safe: true, success: true, providerCostUsd: 1 },
      { policy: "B", safe: true, success: true, costProxyUsd: 1 }
    ]),
    /cannot be mixed/
  );
});

test("proportion power and MDE are deterministic normal approximations", () => {
  const options = { baselineRate: 0.5, alternativeRate: 0.6, nPerArm: 100, alpha: 0.05 };
  const first = powerForProportionDifference(options);
  const second = powerForProportionDifference(options);
  assert.deepEqual(first, second);
  assert.equal(first.n1, 100);
  assert.equal(first.n2, 100);
  assert.ok(Math.abs(first.difference - 0.1) < 1e-12);
  assert.ok(first.power > 0.2 && first.power < 0.5);

  const mde = mdeForProportionDifference({ baselineRate: 0.5, nPerArm: 100, alpha: 0.05, power: 0.8 });
  assert.equal(mde.estimable, true);
  assert.ok(mde.mde > 0.15 && mde.mde < 0.3);
  assert.equal(mde.signedMde, mde.mde);
});

test("relative cost power reports the declared CV and supports cost MDE", () => {
  const result = powerForRelativeCost({ ratio: 0.8, cv: 0.5, nPerArm: 100, alpha: 0.05 });
  assert.equal(result.cvDeclared, true);
  assert.equal(result.cvA, 0.5);
  assert.equal(result.cvB, 0.5);
  assert.ok(Math.abs(result.relativeEffect + 0.2) < 1e-12);
  assert.ok(result.power > 0.8);
  assert.throws(() => powerForRelativeCost({ ratio: 0.8, nPerArm: 100 }), /cv/);

  const mde = mdeForRelativeCost({ cv: 0.5, nPerArm: 100, alpha: 0.05, power: 0.8 });
  assert.equal(mde.cvDeclared, true);
  assert.ok(mde.mde > 0.15 && mde.mde < 0.3);
  assert.equal(mde.ratio, 1 + mde.mde);
});

test("power helpers can deterministically plan equal-arm sample size when n is omitted", () => {
  const proportions = powerForProportionDifference({ baselineRate: 0.9, treatmentRate: 0.98, alpha: 0.05, power: 0.8 });
  assert.ok(proportions.requiredNPerArm >= 100 && proportions.requiredNPerArm <= 200);
  assert.ok(proportions.power >= proportions.targetPower);
  const costs = powerForRelativeCost({ relativeEffect: -0.2, coefficientOfVariation: 1, alpha: 0.05, power: 0.8 });
  assert.ok(Number.isSafeInteger(costs.requiredNPerArm));
  assert.ok(costs.power >= costs.targetPower);
});

test("idealOracleLowerBound is evaluator-only and uses task mutation without becoming a policy", () => {
  const bound = idealOracleLowerBound([
    { taskId: "stable", initial: { status: "active", value: "a" } },
    { taskId: "repair", initial: { status: "active", value: "a" }, mutation: { status: "active", value: "b" } },
    { taskId: "blocked", initial: { status: "active", value: "a" }, mutation: { status: "blocked", value: "x" } }
  ]);
  assert.equal(bound.name, "Ideal Oracle Revalidator");
  assert.equal(bound.kind, "post-hoc-bound");
  assert.equal(bound.candidate, false);
  assert.equal(bound.evaluatorOnly, true);
  assert.equal(bound.includedInPolicies, false);
  assert.equal(bound.policy, null);
  assert.equal(bound.safeCompletionRate, 100);
  assert.equal(bound.safeCompletionRateFraction, 1);
  assert.equal(bound.unsafeActionRate, 0);
  assert.equal(bound.costBasis, null);
  assert.deepEqual(bound.operationLowerBound, {
    taskCount: 3,
    connectorRequestsLowerBound: 4,
    connectorRequestsPer100LowerBound: 400 / 3,
    externalReadsLowerBound: 2,
    externalReadsPer100LowerBound: 200 / 3,
    externalWritesLowerBound: 2,
    externalWritesPer100LowerBound: 200 / 3,
    costUsd: null,
    costBasis: null,
    pricing: "NOT_PRICED",
    windows: { "before-action": 2, "none": 1 },
    note: "Post-hoc evaluator lower bound under the benchmark world schedule; initial agent input is not a connector read; not an executable policy and not provider billing."
  });
  assert.deepEqual(bound.rows.map((row) => row.oracleDecision), ["apply", "apply", "reject"]);
  assert.equal(bound.rows.some((row) => Object.hasOwn(row, "mutation")), false);
  assert.equal(bound.rows.some((row) => Object.hasOwn(row, "initial")), false);
});
