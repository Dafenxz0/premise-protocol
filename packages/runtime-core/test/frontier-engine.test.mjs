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

test("unknown index state is incomplete and cannot become fresh by cache reuse", () => {
  const engine = chain();
  engine.markUnknown();
  const unknown = engine.frontier("T");
  assert.equal(unknown.status, "UNKNOWN");
  assert.equal(unknown.complete, false);
  assert.deepEqual(unknown.frontier, []);
  engine.restoreTrust();
  assert.equal(engine.frontier("T").status, "FRESH");
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
  assert.equal(engine.frontier("T").status, "STALE");
  assert.equal(engine.frontier("X").cacheHit, true);
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
