import assert from "node:assert/strict";
import { DependencyCycleError, DependencyGraph } from "../dist/graph/index.js";

const graph = new DependencyGraph();
graph.addDependency("b", "a");
assert.throws(() => graph.addDependency("a", "b"), DependencyCycleError);
graph.addDependency("c", "b");
assert.throws(() => graph.addDependency("a", "c"), DependencyCycleError);

graph.setDependencies("c", ["a"]);
assert.deepEqual(graph.dependenciesOf("c"), ["a"]);
assert.throws(() => graph.setDependencies("c", ["c"]), DependencyCycleError);
assert.deepEqual(graph.dependenciesOf("c"), ["a"], "failed replacement must be atomic");

const large = new DependencyGraph();
large.addNode("node-0");
for (let index = 1; index <= 1000; index += 1) large.setDependencies(`node-${index}`, [`node-${index - 1}`]);
assert.equal(large.topologicalOrder().length, 1001);
console.log("reference-ts graph tests passed");
