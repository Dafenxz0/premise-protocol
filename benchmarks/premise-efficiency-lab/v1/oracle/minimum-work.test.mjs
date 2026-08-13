import assert from "node:assert/strict";
import test from "node:test";
import {
  CERTIFIED_LOWER_BOUND,
  EXACT,
  UNKNOWN,
  UNBOUNDED,
  calculateWorkAmplification,
  certifyMinimumWork,
  minimumWork
} from "./minimum-work.mjs";

test("tiny complete legal-plan enumeration is explicitly exact", () => {
  const certificate = certifyMinimumWork({
    legalPlanModel: {
      plans: [
        { id: "revalidate", graph: 4, external: 2, validation: 1, write: 1 },
        { id: "receipt", graph: 1, external: 1, validation: 0, write: 1 }
      ]
    }
  });

  assert.equal(certificate.mode, EXACT);
  assert.equal(certificate.dimensions.graph.mode, EXACT);
  assert.equal(certificate.dimensions.graph.minimum, 1);
  assert.equal(certificate.dimensions.external.minimum, 1);
  assert.equal(certificate.dimensions.validation.minimum, 0);
  assert.equal(certificate.dimensions.write.minimum, 1);
  assert.equal(certificate.total.mode, EXACT);
  assert.equal(certificate.total.minimum, 3);
  assert.equal(certificate.dimensions.graph.certificate.kind, "LEGAL_PLAN_ENUMERATION");
});

test("scalable evidence produces certified lower bounds for every physical dimension", () => {
  const certificate = minimumWork({
    graph: {
      affectedNodes: ["root", "child"],
      affectedEdges: [{ from: "root", to: "child" }]
    },
    external: { requiredReads: 2 },
    validation: { criticalPremises: ["p1", "p2", "p3"] },
    write: { requiresWrite: true }
  });

  assert.equal(certificate.mode, CERTIFIED_LOWER_BOUND);
  assert.deepEqual(
    Object.fromEntries(Object.entries(certificate.dimensions).map(([name, value]) => [name, [value.mode, value.minimum]])),
    {
      graph: [CERTIFIED_LOWER_BOUND, 3],
      external: [CERTIFIED_LOWER_BOUND, 2],
      validation: [CERTIFIED_LOWER_BOUND, 3],
      write: [CERTIFIED_LOWER_BOUND, 1]
    }
  );
  assert.equal(certificate.dimensions.graph.certificate.affectedNodes, 2);
  assert.equal(certificate.dimensions.graph.certificate.affectedEdges, 1);
});

test("UNKNOWN is distinct from an explicitly UNBOUNDED dimension", () => {
  const unknown = certifyMinimumWork({ validation: { available: false } });
  const unbounded = certifyMinimumWork({ write: UNBOUNDED });

  assert.equal(unknown.dimensions.graph.minimum, UNKNOWN);
  assert.equal(unknown.dimensions.validation.mode, UNKNOWN);
  assert.equal(unbounded.dimensions.write.minimum, UNBOUNDED);
  assert.equal(unbounded.dimensions.write.mode, UNBOUNDED);
  assert.equal(unbounded.mode, UNBOUNDED);
});

test("work amplification preserves certified, unknown, zero and unbounded semantics", () => {
  const certificate = certifyMinimumWork({
    graph: { lowerBound: 2 },
    external: { lowerBound: 0 },
    validation: { lowerBound: 1 },
    write: UNBOUNDED
  });

  assert.deepEqual(calculateWorkAmplification({ graph: 6, external: 4, validation: UNKNOWN, write: 1 }, certificate), {
    graph: 3,
    external: UNKNOWN,
    validation: UNKNOWN,
    write: UNBOUNDED,
    total: UNKNOWN
  });
  assert.equal(calculateWorkAmplification({ graph: 2, validation: 1, write: 1 }, certificate).graph, 1);
});

test("metamorphic: permuting or adding a dominated legal plan cannot change exact minima", () => {
  const plans = [
    { id: "best", graph: 2, external: 1, validation: 1, write: 1 },
    { id: "other", graph: 5, external: 3, validation: 2, write: 2 }
  ];
  const original = certifyMinimumWork({ legalPlanModel: { plans } });
  const transformed = certifyMinimumWork({
    legalPlanModel: { plans: [plans[1], { id: "dominated", graph: 9, external: 8, validation: 7, write: 6 }, plans[0]] }
  });

  assert.deepEqual(transformed.minimum, original.minimum);
  assert.equal(transformed.mode, original.mode);
  assert.equal(transformed.total.minimum, original.total.minimum);
});

test("metamorphic: disconnected graph additions and duplicate changes do not alter closure work", () => {
  const base = {
    graph: {
      nodes: ["a", "b", "unused"],
      edges: [{ from: "a", to: "b" }],
      changedNodes: ["a", "a"]
    }
  };
  const extended = {
    graph: {
      nodes: ["a", "b", "unused", "extra-1", "extra-2"],
      edges: [
        { from: "a", to: "b" },
        { from: "extra-1", to: "extra-2" }
      ],
      changedNodes: ["a"]
    }
  };

  const first = certifyMinimumWork(base);
  const second = certifyMinimumWork(extended);
  assert.equal(first.dimensions.graph.minimum, 3);
  assert.equal(second.dimensions.graph.minimum, first.dimensions.graph.minimum);
});

test("metamorphic: adding performed work cannot reduce amplification", () => {
  const certificate = certifyMinimumWork({
    graph: { lowerBound: 2 },
    external: { lowerBound: 1 },
    validation: { lowerBound: 1 },
    write: { lowerBound: 1 }
  });
  const lean = calculateWorkAmplification({ graph: 2, external: 1, validation: 1, write: 1 }, certificate);
  const amplified = calculateWorkAmplification({ graph: 4, external: 2, validation: 3, write: 2 }, certificate);

  for (const dimension of ["graph", "external", "validation", "write"]) {
    assert.ok(amplified[dimension] >= lean[dimension]);
  }
});

