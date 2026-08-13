import assert from "node:assert/strict";
import test from "node:test";
import { compareReferenceResult } from "../../referee/blind-evaluator.mjs";
import { referenceForTask } from "./scenario-reference.mjs";

const exact = {
  decision: "USABLE",
  coherence: "FRESH",
  frontier: { status: "FRESH", roots: [], complete: true },
  guardDecision: "ALLOW",
  actionOutcome: { accepted: true, reason: null }
};

test("exact reference match passes all five normative fields", () => {
  const result = compareReferenceResult(exact, structuredClone(exact));
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.fields, {
    decision: "PASS",
    coherence: "PASS",
    frontier: "PASS",
    guard: "PASS",
    actionOutcome: "PASS"
  });
});

test("same safety with a different frontier fails equivalence", () => {
  const candidate = structuredClone(exact);
  candidate.frontier.roots = ["A"];
  const result = compareReferenceResult(exact, candidate);
  assert.equal(result.status, "FAIL");
  assert.equal(result.fields.frontier, "FAIL");
});

test("same final action with the wrong policy decision fails equivalence", () => {
  const candidate = structuredClone(exact);
  candidate.decision = "REVALIDATE";
  const result = compareReferenceResult(exact, candidate);
  assert.equal(result.status, "FAIL");
  assert.equal(result.fields.decision, "FAIL");
});

test("an incomplete frontier fails equivalence even with the same roots", () => {
  const candidate = structuredClone(exact);
  candidate.frontier.complete = false;
  const result = compareReferenceResult(exact, candidate);
  assert.equal(result.status, "FAIL");
  assert.equal(result.fields.frontier, "FAIL");
});

test("the independent scenario reference distinguishes an event mutation", () => {
  const result = referenceForTask({
    nodes: [{ id: "memory:target" }],
    targetIds: ["memory:target"],
    affectsTarget: true,
    deliverEvents: true
  });
  assert.equal(result.decision, "REJECT");
  assert.deepEqual(result.frontier.roots, ["memory:target"]);
  assert.deepEqual(result.actionOutcome, { accepted: false, reason: "REJECT" });
});
