import assert from "node:assert/strict";
import test from "node:test";
import { runIsolationSmoke } from "./smoke.mjs";

test("candidate receives public evidence while oracle retains private mutation truth", async () => {
  const result = await runIsolationSmoke();
  assert.equal(result.candidateDecision, "REJECT");
  assert.equal(result.safe, true);
  assert.equal(result.privateDataStayedPrivate, true);
});
