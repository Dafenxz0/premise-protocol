import assert from "node:assert/strict";
import test from "node:test";
import { IncrementalFrontierEngine } from "../dist/index.js";

function chain() {
  return new IncrementalFrontierEngine([
    { id: "A" },
    { id: "B", dependsOn: ["A"] },
    { id: "T", dependsOn: ["B"] }
  ]);
}

const PRIMITIVE_COUNTER_KEYS = Object.freeze([
  "graphNodeLookups", "graphEdgeTraversals", "reverseIndexLookups", "dirtyStateReads", "dirtyStateWrites",
  "frontierLookups", "frontierRootComparisons", "reachabilityQueries", "reachabilityNodesVisited",
  "reachabilityEdgesTraversed", "cacheLookups", "cacheEntriesScanned", "cacheEntriesPreserved",
  "cacheInvalidations", "cacheWrites", "rootSetReads", "rootSetWrites"
]);
const GRAPH_COUNTER_KEYS = Object.freeze([
  "graphNodeLookups", "graphEdgeTraversals", "reachabilityNodesVisited", "reachabilityEdgesTraversed"
]);
const WORK_PHASES = Object.freeze(["initialization", "maintenance", "query"]);

function sumCounters(counters, keys = PRIMITIVE_COUNTER_KEYS) {
  return keys.reduce((sum, key) => sum + counters[key], 0);
}

function assertWorkInvariants(work, label) {
  for (const phase of WORK_PHASES) {
    const counters = work[phase];
    for (const key of PRIMITIVE_COUNTER_KEYS) {
      assert.ok(Number.isSafeInteger(counters[key]) && counters[key] >= 0, `${label}.${phase}.${key} must be non-negative`);
    }
    assert.equal(
      counters.cacheEntriesScanned,
      counters.cacheInvalidations + counters.cacheEntriesPreserved,
      `${label}.${phase} cache accounting`
    );
    assert.equal(work[`${phase}Work`], sumCounters(counters), `${label}.${phase} primitive work`);
    assert.equal(work[`${phase}GraphWork`], sumCounters(counters, GRAPH_COUNTER_KEYS), `${label}.${phase} graph work`);
  }
  for (const key of [
    "initializationWork", "maintenanceWork", "queryWork", "totalWork", "initializationGraphWork",
    "maintenanceGraphWork", "queryGraphWork", "graphWork", "primitiveWork"
  ]) {
    assert.ok(Number.isSafeInteger(work[key]) && work[key] >= 0, `${label}.${key} must be non-negative`);
  }
  assert.equal(work.totalWork, work.maintenanceWork + work.queryWork, `${label}.totalWork`);
  assert.equal(work.primitiveWork, work.maintenanceWork + work.queryWork, `${label}.primitiveWork`);
  assert.equal(work.totalWork, work.primitiveWork, `${label}.total/primitive work`);
  assert.equal(work.graphWork, work.maintenanceGraphWork + work.queryGraphWork, `${label}.graphWork`);
  assert.equal(work.reconciled, true, `${label}.reconciled`);
}

test("incremental frontier keeps a causal root instead of the full dirty closure", () => {
  const engine = chain();
  const impact = engine.markDirty(["A"]);
  assert.deepEqual(impact.affected, ["A", "B", "T"]);
  assert.deepEqual(engine.frontier("T").frontier, ["A"]);
  assert.equal(engine.frontier("T").status, "STALE");
  assert.equal(engine.frontier("T").cacheHit, true);
  engine.resolve("A");
  assert.deepEqual(engine.frontier("T").frontier, []);
  assert.equal(engine.frontier("T").status, "FRESH");
});

test("resolving A after marking A and B leaves T stale with frontier B", () => {
  const engine = chain();
  engine.markDirty(["A", "B"]);
  assert.equal(engine.frontier("T").status, "STALE");
  assert.deepEqual(engine.frontier("T").frontier, ["A"]);

  engine.resolve("A");
  const result = engine.frontier("T");
  assert.equal(result.status, "STALE");
  assert.deepEqual(result.frontier, ["B"]);
  assert.equal(result.complete, true);
});

test("diamond frontiers preserve incomparable blockers and compress dominated roots", () => {
  const engine = new IncrementalFrontierEngine([
    { id: "A" },
    { id: "B", dependsOn: ["A"] },
    { id: "C", dependsOn: ["A"] },
    { id: "T", dependsOn: ["B", "C"] }
  ]);
  engine.markDirty(["B", "C"]);
  assert.deepEqual(engine.frontier("T").frontier, ["B", "C"]);
  engine.markDirty(["A"]);
  assert.deepEqual(engine.frontier("T").frontier, ["A"]);
});

test("independent branches do not become UNKNOWN when one root resolves", () => {
  const engine = new IncrementalFrontierEngine([
    { id: "A" },
    { id: "B" },
    { id: "T", dependsOn: ["A", "B"] }
  ]);
  engine.markDirty(["A", "B"]);
  assert.deepEqual(engine.frontier("T").frontier, ["A", "B"]);

  engine.resolve("A");
  const result = engine.frontier("T");
  assert.equal(result.status, "STALE");
  assert.deepEqual(result.frontier, ["B"]);
  assert.equal(result.complete, true);
});

test("resolving a non-root node is a safe no-op", () => {
  const engine = chain();
  engine.markDirty(["A"]);
  const before = engine.frontier("B");
  const generation = engine.stats().generation;

  const impact = engine.resolve("B");
  assert.deepEqual(impact.affected, []);
  assert.equal(impact.generation, generation);

  const after = engine.frontier("B");
  assert.equal(after.status, "STALE");
  assert.deepEqual(after.frontier, before.frontier);
  assert.equal(after.complete, true);
  assert.equal(engine.frontier("T").status, "STALE");
});

test("unknown index state is incomplete and cannot become fresh by cache reuse", () => {
  const engine = chain();
  engine.markUnknown();
  const unknown = engine.frontier("T");
  assert.equal(unknown.status, "UNKNOWN");
  assert.equal(unknown.complete, false);
  assert.deepEqual(unknown.frontier, []);
  engine.restoreTrust();
  const stillUnknown = engine.frontier("T");
  assert.equal(stillUnknown.status, "UNKNOWN");
  assert.equal(stillUnknown.complete, false);

  engine.restoreStates([
    { id: "A", status: "FRESH" },
    { id: "B", status: "FRESH" },
    { id: "T", status: "FRESH" }
  ]);
  assert.equal(engine.frontier("T").status, "FRESH");
  assert.equal(engine.frontier("T").complete, true);
});

test("restoreStates validates a complete snapshot linearly and rejects malformed input", () => {
  const engine = chain();
  const snapshot = [
    { id: "T", status: "FRESH" },
    { id: "B", status: "FRESH" },
    { id: "A", status: "STALE" }
  ];

  assert.throws(
    () => engine.restoreStates([...snapshot, { id: "A", status: "STALE" }]),
    /Duplicate/
  );
  assert.throws(
    () => engine.restoreStates(snapshot.map(({ id }) => ({ id, status: "BROKEN" }))),
    /frontier status/
  );
  assert.throws(() => engine.restoreStates(snapshot.slice(0, 2)), /Incomplete frontier state/);

  engine.restoreStates([...snapshot].reverse());
  const restored = engine.frontier("T");
  assert.equal(restored.status, "STALE");
  assert.deepEqual(restored.frontier, ["A"]);
  assert.equal(restored.complete, true);
});

test("replaceStatus(FRESH) is an authoritative replacement for one root", () => {
  const engine = new IncrementalFrontierEngine([
    { id: "A" },
    { id: "B" },
    { id: "T", dependsOn: ["A", "B"] }
  ]);
  engine.markDirty(["A"], "INVALID");
  engine.markDirty(["B"], "STALE");
  assert.equal(engine.frontier("T").status, "INVALID");
  assert.deepEqual(engine.frontier("T").frontier, ["A", "B"]);

  // FRESH replaces A's authoritative state without clearing B's cause.
  engine.replaceStatus("A", "FRESH");
  const result = engine.frontier("T");
  assert.equal(result.status, "STALE");
  assert.deepEqual(result.frontier, ["B"]);
  assert.equal(result.complete, true);
});

test("reactivating a tombstoned root replaces stale severity on compacted and unqueried branches", () => {
  const engine = new IncrementalFrontierEngine([
    { id: "A" },
    { id: "B", dependsOn: ["A"] },
    { id: "T", dependsOn: ["B"] },
    { id: "X", dependsOn: ["A"] }
  ]);
  engine.markDirty(["A"], "INVALID");
  engine.resolve("A");
  // Compact only T. X still carries the lazy tombstone.
  assert.equal(engine.frontier("T").status, "FRESH");

  engine.markDirty(["A"], "STALE");
  assert.equal(engine.frontier("T").status, "STALE");
  assert.equal(engine.frontier("X").status, "STALE");
  assert.deepEqual(engine.frontier("T").frontier, ["A"]);
  assert.deepEqual(engine.frontier("X").frontier, ["A"]);
});

test("frontier budget exhaustion never reports a cached complete result", () => {
  const rootCount = 200;
  const nodes = [
    ...Array.from({ length: rootCount }, (_, index) => ({ id: `r${index}` })),
    ...Array.from({ length: rootCount }, (_, index) => ({
      id: `j${index}`,
      dependsOn: Array.from({ length: rootCount }, (_, root) => `r${root}`)
    }))
  ];
  const engine = new IncrementalFrontierEngine(nodes);
  const impact = engine.markDirty(Array.from({ length: rootCount }, (_, index) => `r${index}`));
  assert.equal(impact.frontierComplete, false);
  assert.equal(engine.stats().frontierBudgetExceeded, true);
  const result = engine.frontier("j0");
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.complete, false);
  assert.equal(result.cacheHit, false);
});

test("invalid roots dominate stale roots and unknown nodes are rejected", () => {
  const engine = chain();
  engine.markDirty(["A"], "STALE");
  engine.markDirty(["A"], "INVALID");
  assert.equal(engine.frontier("T").status, "INVALID");
  assert.throws(() => engine.markDirty(["missing"]), /Unknown node/);
});

test("graph changes invalidate frontier cache and cycles fail closed at construction time", () => {
  const engine = chain();
  engine.frontier("T");
  engine.addNode("U", ["T"]);
  assert.equal(engine.frontier("U").cacheHit, false);
  assert.throws(() => engine.setDependencies("A", ["U"]), /Dependency cycle/);
});

test("constructs and propagates a deep graph without recursive bootstrap", () => {
  const count = 10_000;
  const engine = new IncrementalFrontierEngine(Array.from({ length: count }, (_, index) => ({
    id: `n${index}`,
    dependsOn: index === 0 ? [] : [`n${index - 1}`]
  })));
  const impact = engine.markDirty(["n0"]);
  assert.equal(impact.affected.length, count);
  assert.deepEqual(engine.frontier(`n${count - 1}`).frontier, ["n0"]);
});

test("repeated dirty roots skip already covered branches and preserve unrelated cache entries", () => {
  const engine = new IncrementalFrontierEngine([
    { id: "A" },
    { id: "B", dependsOn: ["A"] },
    { id: "T", dependsOn: ["B"] },
    { id: "X" }
  ]);
  engine.frontier("T");
  engine.frontier("X");
  const first = engine.markDirty(["A"]);
  assert.equal(first.frontierCacheInvalidations, 1);
  assert.equal(first.frontierCacheEntriesPreserved, 1);
  const repeated = engine.markDirty(["A"]);
  assert.ok(repeated.branchesSkippedAlreadyDirty >= 2);
  assert.equal(repeated.nodesVisited, 0);
  assert.deepEqual(repeated.affected, ["A", "B", "T"]);
  assert.equal(repeated.frontierCacheInvalidations, 0);
  assert.equal(repeated.frontierCacheEntriesPreserved, 0);
  assert.equal(engine.frontier("T").status, "STALE");
  assert.equal(engine.frontier("X").cacheHit, true);
});

test("affected closure cache remains bounded under many independent roots", () => {
  const engine = new IncrementalFrontierEngine(Array.from({ length: 300 }, (_, index) => ({ id: `R${index}` })));
  for (let index = 0; index < 300; index += 1) engine.markDirty([`R${index}`]);
  const stats = engine.stats();
  assert.ok(stats.affectedClosureCacheEntries <= 256);
  assert.ok(stats.affectedClosureCacheNodes >= stats.affectedClosureCacheEntries);
  assert.ok(stats.affectedClosureCacheEvictions > 0);
});

test("a severity upgrade propagates through the covered closure", () => {
  const engine = new IncrementalFrontierEngine([
    { id: "A" },
    { id: "B", dependsOn: ["A"] },
    { id: "T", dependsOn: ["B"] }
  ]);
  engine.markDirty(["A"], "STALE");
  const upgrade = engine.markDirty(["A"], "INVALID");
  assert.equal(engine.frontier("T").status, "INVALID");
  assert.ok(upgrade.nodesVisited >= 3);
});

function referenceClosure(nodes, direct) {
  const dependents = new Map(nodes.map(({ id }) => [id, []]));
  for (const node of nodes) for (const dependency of node.dependsOn ?? []) dependents.get(dependency).push(node.id);
  const seen = new Set(direct);
  const queue = [...direct];
  for (let index = 0; index < queue.length; index += 1) {
    for (const dependent of [...dependents.get(queue[index])].sort()) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      queue.push(dependent);
    }
  }
  return seen;
}

function referenceFrontier(nodes, target, direct) {
  const dependencies = new Map(nodes.map(({ id, dependsOn }) => [id, dependsOn ?? []]));
  const dependents = new Map(nodes.map(({ id }) => [id, []]));
  for (const node of nodes) for (const dependency of node.dependsOn ?? []) dependents.get(dependency).push(node.id);
  const reachable = new Set();
  const queue = [target];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const dependency of dependencies.get(id) ?? []) queue.push(dependency);
  }
  const roots = direct.filter((id) => reachable.has(id)).sort();
  const frontier = roots.filter((candidate) => !roots.some((other) => other !== candidate && (() => {
    const seen = new Set();
    const pending = [other];
    for (let index = 0; index < pending.length; index += 1) {
      const id = pending[index];
      for (const dependent of dependents.get(id) ?? []) {
        if (dependent === candidate) return true;
        if (seen.has(dependent)) continue;
        seen.add(dependent);
        pending.push(dependent);
      }
    }
    return false;
  })()));
  return {
    status: frontier.length === 0 ? "FRESH" : "STALE",
    frontier
  };
}

test("incremental affected closure is differentially equivalent to a reference traversal", () => {
  let state = 0x9e3779b9;
  const random = () => {
    state = (Math.imul(state ^ (state >>> 16), 2246822519) + 3266489917) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let round = 0; round < 10_000; round += 1) {
    const nodes = Array.from({ length: 24 }, (_, index) => ({
      id: `n${index}`,
      dependsOn: Array.from({ length: index }, (_, dependency) => dependency)
        .filter(() => random() < 0.12)
        .map((dependency) => `n${dependency}`)
    }));
    const engine = new IncrementalFrontierEngine(nodes);
    const direct = nodes.filter(() => random() < 0.15).map(({ id }) => id);
    const seeds = direct.length === 0 ? ["n0"] : direct;
    const impact = engine.markDirty(seeds);
    assert.deepEqual(new Set(impact.affected), referenceClosure(nodes, seeds), `round ${round}`);
    const expected = referenceFrontier(nodes, "n23", seeds);
    const actual = engine.frontier("n23");
    assert.equal(actual.status, expected.status, `status round ${round}`);
    assert.deepEqual(actual.frontier, expected.frontier, `frontier round ${round}`);
    assert.equal(actual.complete, true, `complete round ${round}`);
  }
});

test("frontier work remains reconciled across initialization, maintenance, and query phases", () => {
  const engine = new IncrementalFrontierEngine([
    { id: "A" },
    { id: "B", dependsOn: ["A"] },
    { id: "T", dependsOn: ["B"] },
    { id: "X" }
  ]);

  const initialized = engine.stats().workBreakdown;
  assertWorkInvariants(initialized, "initialization");
  assert.ok(initialized.initializationWork > 0);
  assert.equal(initialized.maintenanceWork, 0);
  assert.equal(initialized.queryWork, 0);

  const firstQuery = engine.frontier("T");
  const unrelatedQuery = engine.frontier("X");
  for (const [index, result] of [firstQuery, unrelatedQuery].entries()) {
    assertWorkInvariants(result.workBreakdown, `query-${index}`);
    assert.equal(result.workBreakdown.initializationWork, 0);
    assert.equal(result.workBreakdown.maintenanceWork, 0);
    assert.ok(result.workBreakdown.queryWork > 0);
  }

  const impact = engine.markDirty(["A"]);
  assertWorkInvariants(impact.workBreakdown, "maintenance");
  assert.equal(impact.workBreakdown.initializationWork, 0);
  assert.ok(impact.workBreakdown.maintenanceWork > 0);
  assert.equal(impact.workBreakdown.queryWork, 0);
  assert.equal(impact.workBreakdown.maintenance.cacheEntriesScanned, 2);
  assert.equal(
    impact.workBreakdown.maintenance.cacheEntriesScanned,
    impact.frontierCacheInvalidations + impact.frontierCacheEntriesPreserved
  );
  assert.equal(impact.frontierCacheInvalidations, 1);
  assert.equal(impact.frontierCacheEntriesPreserved, 1);

  const cacheMiss = engine.frontier("T");
  const cacheHit = engine.frontier("X");
  assert.equal(cacheMiss.cacheHit, false);
  assert.equal(cacheHit.cacheHit, true);
  assertWorkInvariants(cacheMiss.workBreakdown, "query-miss");
  assertWorkInvariants(cacheHit.workBreakdown, "query-hit");

  const cumulative = engine.stats().workBreakdown;
  assertWorkInvariants(cumulative, "cumulative");
  assert.ok(cumulative.initializationWork > 0);
  assert.ok(cumulative.maintenanceWork > 0);
  assert.ok(cumulative.queryWork > 0);
});

test("affected closure is exact and rejected cycle updates preserve trusted cache state", () => {
  const nodes = [
    { id: "A" },
    { id: "B", dependsOn: ["A"] },
    { id: "T", dependsOn: ["B"] },
    { id: "X" }
  ];
  const engine = new IncrementalFrontierEngine(nodes);
  engine.frontier("T");
  engine.frontier("X");

  const impact = engine.markDirty(["A"]);
  assert.deepEqual(impact.affected, [...referenceClosure(nodes, ["A"])].sort());
  assertWorkInvariants(impact.workBreakdown, "closure-maintenance");

  const stale = engine.frontier("T");
  assert.equal(stale.cacheHit, false);
  assert.equal(stale.status, "STALE");
  assert.deepEqual(stale.frontier, ["A"]);
  const beforeCycle = engine.stats();
  const cachedBeforeCycle = engine.frontier("T");
  assert.equal(cachedBeforeCycle.cacheHit, true);

  assert.throws(() => engine.setDependencies("A", ["T"]), /Dependency cycle/);

  const afterCycle = engine.stats();
  assert.equal(afterCycle.graphRevision, beforeCycle.graphRevision);
  assert.equal(afterCycle.generation, beforeCycle.generation);
  assert.equal(afterCycle.nodeCount, beforeCycle.nodeCount);
  assert.equal(afterCycle.cacheEntries, beforeCycle.cacheEntries);
  assertWorkInvariants(afterCycle.workBreakdown, "rejected-cycle");

  const cachedAfterCycle = engine.frontier("T");
  assert.equal(cachedAfterCycle.cacheHit, true);
  assert.deepEqual(cachedAfterCycle.frontier, cachedBeforeCycle.frontier);
  assert.equal(engine.frontier("X").cacheHit, true);
});
