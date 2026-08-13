import assert from "node:assert/strict";
import { runEfficiencyCampaign } from "./campaign.mjs";
import { assertPublicData, generateAttackFixtures } from "./attacks/index.mjs";
import { certifyMinimumWork } from "./oracle/minimum-work.mjs";
import { runIsolationSmoke } from "./isolation/smoke.mjs";

const result = await runEfficiencyCampaign({ seed: 20260813, tasks: 8 });
assert.equal(result.status, "INCONCLUSIVE");
assert.equal(result.campaignMode, "CALIBRATION_ONLY");
assert.equal(result.claims.runtimeCandidateIsPhysical, true);
assert.equal(result.claims.candidateOraclePhysicalIsolation, false);
assert.equal(result.blind.ranking.length, 0);
assert.equal(result.blind.rankingSuppressed, true);
assert.equal(result.examined.premise.referenceEquivalent, "PASS");
assert.equal(result.examined.premise.unsafeActions, 0);
assert.equal(result.examined.premise.toctouEscapes, 0);
assert.ok(result.examined.premise.sourceReads > 0);
assert.ok(result.examined.premise.nodesVisited > 0);

for (const task of result.publicTasks) {
  assertPublicData(task);
  assert.equal(Object.hasOwn(task, "affectsTarget"), false);
  assert.equal(Object.hasOwn(task, "mutation"), false);
}

const attacks = generateAttackFixtures({ profile: "smoke", seed: 20260813 });
for (const fixture of Object.values(attacks)) assertPublicData(fixture);

const exact = certifyMinimumWork({ legalPlanModel: { plans: [{ graph: 1, external: 1, validation: 1, write: 1 }] } });
assert.equal(exact.mode, "EXACT");
const isolation = await runIsolationSmoke();
assert.equal(isolation.safe, true);
assert.equal(isolation.privateDataStayedPrivate, true);

process.stdout.write(JSON.stringify({
  status: "PASS",
  campaign: { tasks: result.taskCount, eligibleCandidates: result.blind.eligibleCount },
  attackFamilies: Object.keys(attacks).length,
  oracleMode: exact.mode,
  isolation: "PASS"
}, null, 2) + "\n");
