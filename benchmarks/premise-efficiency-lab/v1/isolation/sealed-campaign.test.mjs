import assert from "node:assert/strict";
import test from "node:test";
import {
  SEALED_CAMPAIGN_FORMAT,
  SEALED_LABEL,
  runSealedCampaign,
  runSealedTask
} from "./sealed-campaign.mjs";
import { findForbiddenFields } from "./protocol.mjs";

test("sealed campaign runs runtime-core in a public-only child and keeps truth in the parent", async () => {
  const result = await runSealedCampaign();

  assert.equal(result.format, SEALED_CAMPAIGN_FORMAT);
  assert.equal(result.status, "SEALED");
  assert.equal(result.label, SEALED_LABEL);
  assert.equal(result.isolation.complete, true);
  assert.equal(result.isolation.candidateProcess, true);
  assert.equal(result.isolation.publicInputOnly, true);
  assert.equal(result.isolation.truthOwner, "parent");
  assert.equal(result.isolation.mutationOwner, "parent");
  assert.equal(result.isolation.shell, false);
  assert.equal(result.claims.runtimeCandidateIsPhysical, true);
  assert.equal(result.claims.candidateOraclePhysicalIsolation, true);
  assert.equal(result.claims.commercialEfficiencyClaim, false);
  assert.equal(result.summary.unsafeActions, 0);
  assert.equal(result.summary.falseBlocks, 0);
  assert.equal(result.summary.toctouEscapes, 0);
  assert.ok(result.summary.counters.sourceReads > 0);
  assert.ok(result.summary.counters.CASAttempts > 0);
  assert.ok(result.tasks.every((task) => task.status === "COMPLETE"));
  assert.ok(result.tasks.every((task) => task.counters.decisions > 0));
  assert.equal(findForbiddenFields(result.publicTasks).length, 0);
  assert.equal(JSON.stringify(result).includes("revision: 1"), false);
});

test("sealed candidate handles an event mutation and a parent-owned CAS mutation", async () => {
  const result = await runSealedCampaign();

  assert.equal(result.status, "SEALED");
  assert.equal(result.summary.unsafeActions, 0);
  assert.equal(result.summary.falseBlocks, 0);
  assert.ok(result.summary.counters.CASConflicts >= 1);
  assert.ok(result.tasks.some((task) => task.safety.affectedMutationDetected));
  assert.ok(result.tasks.every((task) => task.sourceCommitted === false || task.actionAccepted === true));
});

test("a forbidden public field fails closed as INCONCLUSIVE", async () => {
  const result = await runSealedCampaign({
    tasks: [{
      publicTask: { taskId: "forbidden", expectedDecision: "ACTION" },
      privateSpec: { sourceUri: "sealed://source/forbidden", initialVersion: "v0" }
    }]
  });

  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(result.label, "INCONCLUSIVE");
  assert.equal(result.isolation.complete, false);
  assert.equal(result.claims.commercialEfficiencyClaim, false);
});

test("single-task failures are reported without exposing private mutation material", async () => {
  const result = await runSealedTask({
    publicTask: { taskId: "invalid", expectedDecision: "REJECT" },
    privateSpec: {
      sourceUri: "sealed://source/private-secret",
      initialVersion: "v0",
      mutation: { version: "v1", value: "private-secret" }
    }
  });

  assert.equal(result.status, "INCONCLUSIVE");
  assert.equal(JSON.stringify(result).includes("private-secret"), false);
});
