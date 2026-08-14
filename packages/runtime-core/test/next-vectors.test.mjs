import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  NegativePremiseStore,
  assessReceiptSubsumption,
  classifyPredicateChange,
  createPredicateDependency,
  evaluatePredicate,
  selectSubsumingReceipt
} from "../dist/index.js";

const vectorRoot = new URL("../../../spec/premise-next/vectors/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", vectorRoot), "utf8"));
const vectors = await Promise.all(manifest.vectors.map(async (name) => JSON.parse(await readFile(new URL(name, vectorRoot), "utf8"))));

function negative(vector) {
  const store = new NegativePremiseStore();
  if (vector.premise !== null) {
    store.putAbsent({
      ...vector.premise.scope,
      reason: "vector",
      observedAt: vector.premise.observedAt,
      expiresAt: vector.premise.expiresAt
    });
  }
  return store.check(vector.scope, vector.now, vector.observation);
}

function predicate(vector) {
  const dependency = vector.dependency.semanticFingerprint === undefined
    ? createPredicateDependency(vector.dependency)
    : vector.dependency;
  return {
    previousEvaluation: evaluatePredicate(vector.previousValue, dependency.predicate),
    currentEvaluation: evaluatePredicate(vector.currentValue, dependency.predicate),
    change: classifyPredicateChange(dependency, vector.previousValue, vector.currentValue)
  };
}

function receipt(vector) {
  const result = vector.operation === "receipt_select"
    ? selectSubsumingReceipt(vector.candidates, vector.requirement)
    : assessReceiptSubsumption(vector.candidate, vector.requirement);
  return {
    eligible: result.eligible,
    reason: result.reason,
    ...(result.receipt === undefined ? {} : { receiptId: result.receipt.receiptId })
  };
}

for (const vector of vectors.filter(({ operation }) => ["negative", "predicate", "receipt", "receipt_select"].includes(operation))) {
  test(`TypeScript matches shared vector ${vector.id}`, () => {
    const actual = vector.operation === "negative" ? negative(vector)
      : vector.operation === "predicate" ? predicate(vector)
        : receipt(vector);
    assert.deepEqual(actual, vector.expected);
  });
}
