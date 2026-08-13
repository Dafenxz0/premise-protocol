import test from "node:test";
import assert from "node:assert/strict";
import { compareResults, rootExplosionPlan } from "./root-explosion.mjs";

test("root-explosion plan is frozen and covers the four adversarial topologies", () => {
  const plan = rootExplosionPlan("smoke");
  assert.equal(plan.length, 16);
  assert.deepEqual([...new Set(plan.map(({ topology }) => topology))], ["nested-diamond", "meshed", "reconvergent", "wide"]);
  assert.deepEqual([...new Set(plan.map(({ roots }) => roots))], [16, 32, 64, 128]);
  assert.deepEqual([...new Set(plan.map(({ order }) => order))], ["forward"]);
});

test("champion timeout is inconclusive, never a false candidate win", () => {
  const candidate = { status: "PASS", accountingReconciled: true, counterContract: { complete: true, normalized: true }, physicalWork: 10 };
  const champion = { status: "TIMEOUT" };
  assert.deepEqual(compareResults(candidate, champion), {
    status: "INCONCLUSIVE",
    reason: "champion timed out",
    equivalent: null
  });
});

test("candidate timeout is inconclusive, never a false failure or win", () => {
  assert.deepEqual(compareResults({ status: "TIMEOUT" }, { status: "PASS" }), {
    status: "INCONCLUSIVE",
    reason: "candidate timed out",
    equivalent: null
  });
});

test("candidate budget overflow is inconclusive, never a false failure", () => {
  assert.deepEqual(compareResults({ status: "INCONCLUSIVE", reason: "budget" }, { status: "PASS" }), {
    status: "INCONCLUSIVE",
    reason: "budget",
    equivalent: null
  });
});

test("two incomplete results cannot be certified as an equivalent PASS", () => {
  const candidate = {
    status: "PASS",
    accountingReconciled: true,
    counterContract: { complete: true, normalized: true },
    affectedCount: 0,
    affectedDigest: "a",
    frontierCount: 0,
    frontierDigest: "f",
    decision: { status: "UNKNOWN", complete: false },
    physicalWork: 1
  };
  const champion = { ...candidate, counterContract: { complete: true, normalized: true } };
  assert.deepEqual(compareResults(candidate, champion), {
    status: "FAIL",
    reason: "behavior mismatch",
    equivalent: false,
    physicalReduction: null
  });
});

test("resource errors are represented as inconclusive rather than a win", () => {
  assert.deepEqual(compareResults({ status: "INCONCLUSIVE", reason: "OOM" }, { status: "PASS" }), {
    status: "INCONCLUSIVE",
    reason: "OOM",
    equivalent: null
  });
});

test("equivalent behavior is required before reporting physical reduction", () => {
  const candidate = { status: "PASS", accountingReconciled: true, counterContract: { complete: true, normalized: true }, affectedCount: 1, affectedDigest: "a", frontierCount: 1, frontierDigest: "f", decision: { status: "STALE", complete: true }, physicalWork: 25 };
  const champion = { status: "PASS", accountingReconciled: true, counterContract: { complete: true, normalized: true }, affectedCount: 1, affectedDigest: "a", frontierCount: 1, frontierDigest: "f", decision: { status: "STALE", complete: true }, physicalWork: 100 };
  const result = compareResults(candidate, champion);
  assert.equal(result.status, "PASS");
  assert.equal(result.equivalent, true);
  assert.equal(result.physicalReduction, 0.75);
});

test("behavior mismatch is a hard failure", () => {
  const candidate = { status: "PASS", accountingReconciled: true, counterContract: { complete: true, normalized: true }, affectedCount: 1, affectedDigest: "a", frontierCount: 1, frontierDigest: "candidate", decision: { status: "STALE", complete: true }, physicalWork: 25 };
  const champion = { status: "PASS", accountingReconciled: true, counterContract: { complete: true, normalized: true }, affectedCount: 1, affectedDigest: "a", frontierCount: 1, frontierDigest: "champion", decision: { status: "STALE", complete: true }, physicalWork: 100 };
  assert.equal(compareResults(candidate, champion).status, "FAIL");
});
