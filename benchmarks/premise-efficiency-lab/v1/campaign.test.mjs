import assert from "node:assert/strict";
import test from "node:test";
import { buildCampaignTasks, runEfficiencyCampaign } from "./campaign.mjs";

test("v1 campaign keeps private mutation truth out of public tasks", () => {
  const tasks = buildCampaignTasks({ seed: 20260813, tasks: 64, privateScheduleKey: "test-schedule-a" });
  assert.equal(tasks.length, 64);
  for (const task of tasks) {
    assert.equal(Object.hasOwn(task.publicTask, "affectsTarget"), false);
    assert.equal(Object.hasOwn(task.publicTask, "mutation"), false);
    assert.equal(Object.hasOwn(task.publicTask, "privateSpec"), false);
  }
  const assignments = tasks.map((task) => task.privateSpec.affectsTarget);
  assert.equal(assignments.some(Boolean), true);
  assert.equal(assignments.some((value) => !value), true);
  assert.notDeepEqual(assignments, assignments.map((_, index) => index % 2 === 1));

  const alternate = buildCampaignTasks({ seed: 20260813, tasks: 64, privateScheduleKey: "test-schedule-b" });
  assert.deepEqual(alternate.map((task) => task.publicTask), tasks.map((task) => task.publicTask));
  assert.notDeepEqual(alternate.map((task) => task.privateSpec.affectsTarget), assignments);
});

test("v1 campaign executes runtime-core physically and applies gates before ranking", async () => {
  const result = await runEfficiencyCampaign({ seed: 20260813, tasks: 8 });
  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.campaignMode, "CALIBRATION_ONLY");
  assert.equal(result.claims.runtimeCandidateIsPhysical, true);
  assert.equal(result.claims.candidateOraclePhysicalIsolation, false);
  assert.equal(result.claims.scientificRanking, false);
  const premise = result.examined.premise;
  assert.equal(premise.referenceEquivalent, "PASS");
  assert.equal(premise.unsafeActions, 0);
  assert.equal(premise.toctouEscapes, 0);
  assert.ok(premise.sourceReads > 0);
  assert.ok(premise.nodesVisited > 0);
  assert.equal(premise.staleReceiptReuse, "UNKNOWN");
  assert.equal(premise.incarnationViolations, "UNKNOWN");
  assert.equal(result.blind.status, "INCONCLUSIVE");
  assert.equal(result.blind.eligibleCount, 0);
  assert.equal(result.blind.rankingSuppressed, true);
  assert.equal(result.blind.scientificRanking, null);
  assert.equal(result.blind.ranking.length, 0);
  assert.equal(result.oracleCertificate.mode, "UNKNOWN");
  assert.ok(Object.values(result.amplifications).every((value) => value.mode === "UNKNOWN"));
  assert.ok(result.commit === null || /^[0-9a-f]{40}$/i.test(result.commit));
  assert.ok(result.artifactDigest === null || /^sha256:[0-9a-f]{64}$/.test(result.artifactDigest));
  assert.equal(result.config.mode, "CALIBRATION_ONLY");
  assert.match(result.provenance.privateScheduleDigest, /^sha256:[0-9a-f]{64}$/);
});

test("v1 campaign requires a positive safe-completion floor", async () => {
  await assert.rejects(
    () => runEfficiencyCampaign({ seed: 20260813, tasks: 1, safeCompletionFloor: 0 }),
    RangeError
  );
});
