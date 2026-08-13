const TOPOLOGIES = Object.freeze(["chain", "star", "diamond", "nested-diamond", "wide", "meshed"]);

function assertNodeCount(nodeCount) {
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 2) throw new RangeError("nodeCount must be an integer >= 2");
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state ^ (state >>> 16), 2246822519) + 3266489917) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function unique(values) {
  return [...new Set(values)];
}

function node(id, dependsOn = []) {
  return Object.freeze({ id, ...(dependsOn.length === 0 ? {} : { dependsOn: Object.freeze(unique(dependsOn)) }) });
}

function chain(nodeCount) {
  return Array.from({ length: nodeCount }, (_, index) => node(`n${index}`, index === 0 ? [] : [`n${index - 1}`]));
}

function star(nodeCount) {
  return [node("n0"), ...Array.from({ length: nodeCount - 1 }, (_, index) => node(`n${index + 1}`, ["n0"]))];
}

function diamond(nodeCount) {
  const nodes = [node("n0")];
  for (let index = 1; index < nodeCount - 1; index += 1) {
    const parent = index % 2 === 0 ? `n${index - 1}` : `n${Math.max(0, index - 2)}`;
    nodes.push(node(`n${index}`, [parent]));
  }
  nodes.push(node(`n${nodeCount - 1}`, [
    `n${Math.max(0, nodeCount - 2)}`,
    `n${Math.max(0, nodeCount - 3)}`
  ]));
  return nodes;
}

function nestedDiamond(nodeCount) {
  const nodes = [node("n0")];
  let current = "n0";
  let index = 1;
  while (index + 2 < nodeCount) {
    const left = `n${index}`;
    const right = `n${index + 1}`;
    const join = `n${index + 2}`;
    nodes.push(node(left, [current]));
    nodes.push(node(right, [current]));
    nodes.push(node(join, [left, right]));
    current = join;
    index += 3;
  }
  while (nodes.length < nodeCount) {
    const id = `n${nodes.length}`;
    nodes.push(node(id, [current]));
    current = id;
  }
  return nodes;
}

function wide(nodeCount) {
  const join = `n${nodeCount - 1}`;
  const middle = Math.max(1, Math.floor(nodeCount / 2));
  const nodes = [node("n0")];
  for (let index = 1; index < nodeCount - 1; index += 1) {
    nodes.push(node(`n${index}`, index < middle ? ["n0"] : [`n${Math.max(1, index - 1)}`]));
  }
  nodes.push(node(join, [
    `n${Math.max(1, middle - 1)}`,
    `n${Math.max(1, nodeCount - 2)}`
  ]));
  return nodes;
}

function meshed(nodeCount, seed) {
  const next = random(seed);
  return Array.from({ length: nodeCount }, (_, index) => {
    if (index === 0) return node("n0");
    const candidates = [];
    for (let distance = 1; distance <= Math.min(index, 6); distance += 1) {
      if (next() < 0.42) candidates.push(`n${index - distance}`);
    }
    if (candidates.length === 0) candidates.push(`n${index - 1}`);
    return node(`n${index}`, unique(candidates));
  });
}

export function generateGraph({ topology = "chain", nodeCount = 100, seed = 1 } = {}) {
  assertNodeCount(nodeCount);
  if (!TOPOLOGIES.includes(topology)) throw new RangeError(`Unknown topology: ${topology}`);
  const nodes = topology === "chain" ? chain(nodeCount)
    : topology === "star" ? star(nodeCount)
      : topology === "diamond" ? diamond(nodeCount)
        : topology === "nested-diamond" ? nestedDiamond(nodeCount)
          : topology === "wide" ? wide(nodeCount)
            : meshed(nodeCount, seed);
  return Object.freeze(nodes);
}

export function graphTopologies() {
  return TOPOLOGIES;
}

export function graphSize(nodes) {
  return Object.freeze({
    nodes: nodes.length,
    edges: nodes.reduce((sum, item) => sum + (item.dependsOn?.length ?? 0), 0)
  });
}

export function deterministicRoots(nodes, count = 1) {
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError("count must be positive");
  return Array.from({ length: Math.min(count, nodes.length) }, (_, index) => nodes[Math.floor(index * nodes.length / count)].id);
}
