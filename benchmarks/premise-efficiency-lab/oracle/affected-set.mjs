function assertGraph(graph) {
  if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new TypeError("graph must contain nodes and edges arrays");
  }
  const nodes = new Set(graph.nodes);
  if (nodes.size !== graph.nodes.length || [...nodes].some((id) => typeof id !== "string" || id.length === 0)) {
    throw new TypeError("graph nodes must be unique non-empty strings");
  }
  for (const edge of graph.edges) {
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") {
      throw new TypeError("graph edges must contain string from/to fields");
    }
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to) {
      throw new RangeError("graph edge references an invalid node");
    }
  }
  return nodes;
}

export function buildDependencyIndex(graph) {
  const nodes = assertGraph(graph);
  const dependents = new Map([...nodes].map((node) => [node, []]));
  const dependencies = new Map([...nodes].map((node) => [node, []]));
  for (const edge of graph.edges) {
    dependents.get(edge.from).push(edge.to);
    dependencies.get(edge.to).push(edge.from);
  }
  for (const values of dependents.values()) values.sort();
  for (const values of dependencies.values()) values.sort();
  return Object.freeze({ dependents, dependencies });
}

export function affectedSet(graph, changedNodes, options = {}) {
  const nodes = assertGraph(graph);
  if (!changedNodes || typeof changedNodes[Symbol.iterator] !== "function") {
    throw new TypeError("changedNodes must be iterable");
  }
  const includeChanged = options.includeChanged !== false;
  const { dependents } = buildDependencyIndex(graph);
  const affected = new Set();
  const queue = [];
  for (const node of changedNodes) {
    if (!nodes.has(node)) throw new RangeError(`unknown changed node: ${node}`);
    if (!affected.has(node)) {
      affected.add(node);
      queue.push(node);
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const dependent of dependents.get(queue[cursor])) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      queue.push(dependent);
    }
  }
  if (!includeChanged) for (const node of changedNodes) affected.delete(node);
  return affected;
}

export function inducedEdges(graph, nodeSet) {
  const nodes = nodeSet instanceof Set ? nodeSet : new Set(nodeSet);
  assertGraph(graph);
  return graph.edges.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to));
}

export function topologicalSubset(graph, nodeSet) {
  const nodes = nodeSet instanceof Set ? nodeSet : new Set(nodeSet);
  assertGraph(graph);
  const order = Array.isArray(graph.metadata?.topologicalOrder)
    ? graph.metadata.topologicalOrder
    : graph.nodes;
  return order.filter((node) => nodes.has(node));
}

export function summarizeImpact(graph, changedNodes) {
  const affected = affectedSet(graph, changedNodes);
  const edges = inducedEdges(graph, affected);
  return Object.freeze({
    changedCount: [...changedNodes].length,
    affectedCount: affected.size,
    affectedEdges: edges.length,
    affectedNodes: Object.freeze(topologicalSubset(graph, affected))
  });
}
