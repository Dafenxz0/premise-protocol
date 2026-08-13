import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCompactionDeclaration,
  COMPACTION_GATE_FORMAT,
  CURRENT_COMPACTION_EVALUATION,
  evaluateCompactionDeclaration,
  REQUIRED_COMPACTION_INVARIANTS
} from "./gate.mjs";

function completeProof(id) {
  return {
    status: "PASS",
    deterministic: true,
    independentOracle: true,
    testFile: `benchmarks/premise-efficiency-lab/v1/compaction/${id}.test.mjs`,
    testCount: 1
  };
}

function completeDeclaration() {
  return {
    status: "GO",
    compactionImplemented: true,
    invariants: Object.fromEntries(REQUIRED_COMPACTION_INVARIANTS.map(({ id }) => [id, completeProof(id)]))
  };
}

test("the current PR31 verdict is explicitly NO-GO", () => {
  assert.equal(CURRENT_COMPACTION_EVALUATION.format, COMPACTION_GATE_FORMAT);
  assert.equal(CURRENT_COMPACTION_EVALUATION.status, "NO-GO");
  assert.equal(CURRENT_COMPACTION_EVALUATION.accepted, false);
  assert.deepEqual(
    CURRENT_COMPACTION_EVALUATION.missingInvariants,
    REQUIRED_COMPACTION_INVARIANTS.map(({ id }) => id)
  );
});

test("a GO declaration without invariant evidence fails closed", () => {
  const evaluation = evaluateCompactionDeclaration({ status: "GO", compactionImplemented: true });

  assert.equal(evaluation.status, "NO-GO");
  assert.equal(evaluation.accepted, false);
  assert.ok(evaluation.reasonCodes.includes("MISSING_REQUIRED_INVARIANTS"));
  assert.deepEqual(
    evaluation.missingInvariants,
    REQUIRED_COMPACTION_INVARIANTS.map(({ id }) => id)
  );
  assert.throws(
    () => assertCompactionDeclaration({ status: "GO", compactionImplemented: true }),
    (error) => error.code === "COMPACTION_NO_GO" && error.evaluation.status === "NO-GO"
  );
});

test("partial, failed or non-deterministic evidence stays NO-GO", () => {
  const [first, ...rest] = REQUIRED_COMPACTION_INVARIANTS;
  const partial = evaluateCompactionDeclaration({
    status: "GO",
    compactionImplemented: true,
    invariants: { [first.id]: completeProof(first.id) }
  });
  assert.equal(partial.status, "NO-GO");
  assert.equal(partial.missingInvariants.length, rest.length);

  const failed = completeDeclaration();
  failed.invariants[first.id] = { ...completeProof(first.id), status: "FAIL" };
  const failedEvaluation = evaluateCompactionDeclaration(failed);
  assert.equal(failedEvaluation.status, "NO-GO");
  assert.deepEqual(failedEvaluation.invalidInvariants, [first.id]);

  const nonDeterministic = completeDeclaration();
  nonDeterministic.invariants[first.id] = { ...completeProof(first.id), deterministic: false };
  const nonDeterministicEvaluation = evaluateCompactionDeclaration(nonDeterministic);
  assert.equal(nonDeterministicEvaluation.status, "NO-GO");
  assert.deepEqual(nonDeterministicEvaluation.invalidInvariants, [first.id]);
});

test("a complete proof-shaped declaration is the only accepted contract fixture", () => {
  const declaration = completeDeclaration();
  const first = evaluateCompactionDeclaration(declaration);
  const second = evaluateCompactionDeclaration(declaration);

  assert.deepEqual(first, second);
  assert.equal(first.status, "GO");
  assert.equal(first.accepted, true);
  assert.deepEqual(first.missingInvariants, []);
  assert.deepEqual(first.invalidInvariants, []);
  assert.deepEqual(assertCompactionDeclaration(declaration), first);
});

test("malformed declarations and proof records fail closed", () => {
  for (const declaration of [null, [], {}, { status: "PASS", compactionImplemented: true }, { status: "GO" }]) {
    assert.equal(evaluateCompactionDeclaration(declaration).status, "NO-GO");
  }

  const malformed = completeDeclaration();
  malformed.invariants[REQUIRED_COMPACTION_INVARIANTS[0].id] = {
    status: "PASS",
    deterministic: true,
    independentOracle: true,
    testFile: "",
    testCount: 0
  };
  const evaluation = evaluateCompactionDeclaration(malformed);
  assert.equal(evaluation.status, "NO-GO");
  assert.deepEqual(evaluation.invalidInvariants, [REQUIRED_COMPACTION_INVARIANTS[0].id]);
});
