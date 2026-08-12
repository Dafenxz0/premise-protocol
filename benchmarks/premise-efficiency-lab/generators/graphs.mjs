import { createHash } from "node:crypto";

const DEFAULT_SEED = "premise-efficiency-lab";
const DEFAULT_NODE_COUNT = 8;
const TOPOLOGIES = Object.freeze(["chain", "star", "diamond", "deep", "wide", "mesh"]);

function stableJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function stableHash(value) {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

export function normalizeSeed(seed = DEFAULT_SEED) {
  if (typeof seed === "string") {
    if (seed.length === 0) throw new TypeError("seed must not be empty");
    return seed;
  }
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) throw new TypeError("seed must be finite");
    return String(seed);
  }
  if (typeof seed === "bigint") return String(seed);
  throw new TypeError("seed must be a non-empty string, finite number, or bigint");
}

function hashSeed(seed) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 0x9e3779b9;
}

export function createSeededRandom(seed = DEFAULT_SEED) {
  let state = hashSeed(normalizeSeed(seed));
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function optionsObject(options) {
  if (options === undefined) return {};
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  return options;
}

function positiveInteger(value, name, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function probability(value, name, fallback) {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isFinite(result) || result < 0 || result > 1) {
    throw new RangeError(`${name} must be a number between 0 and 1`);
  }
  return result;
}

function optionCount(options, fallback = DEFAULT_NODE_COUNT) {
  const value = options.nodeCount ?? options.size ?? fallback;
  return positiveInteger(value, "nodeCount");
}

function nodeId(index) {
  return `node-${String(index).padStart(4, "0")}`;
}

function layerNodes(sizes) {
  let next = 0;
  return sizes.map((size) => Array.from({ length: size }, () => nodeId(next++)));
}

function shuffle(items, random) {
  const output = [...items];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [output[index], output[other]] = [output[other], output[index]];
  }
  return output;
}

function connectLayerPair(fromLayer, toLayer, random, density) {
  const edges = [];
  const edgeKeys = new Set();
  const outgoing = new Map(fromLayer.map((id) => [id, 0]));
  const incoming = new Map(toLayer.map((id) => [id, 0]));
  const add = (from, to) => {
    const key = `${from}\u0000${to}`;
    if (edgeKeys.has(key)) return false;
    edgeKeys.add(key);
    edges.push({ from, to });
    outgoing.set(from, outgoing.get(from) + 1);
    incoming.set(to, incoming.get(to) + 1);
    return true;
  };

  for (const to of toLayer) {
    const from = fromLayer[Math.floor(random() * fromLayer.length)];
    add(from, to);
  }

  for (const from of fromLayer) {
    if (outgoing.get(from) > 0) continue;
    const to = toLayer[Math.floor(random() * toLayer.length)];
    add(from, to);
  }

  const totalPairs = fromLayer.length * toLayer.length;
  const edgeBudget = Math.max(
    edges.length,
    Math.min(totalPairs, Math.max(fromLayer.length, toLayer.length) * 8, Math.ceil(totalPairs * density))
  );
  let attempts = 0;
  const maxAttempts = Math.min(totalPairs * 2, Math.max(edgeBudget * 4, 100));
  while (edges.length < edgeBudget && attempts < maxAttempts) {
    attempts += 1;
    const from = fromLayer[Math.floor(random() * fromLayer.length)];
    const to = toLayer[Math.floor(random() * toLayer.length)];
    add(from, to);
  }
  return edges;
}

function distribute(total, layers) {
  positiveInteger(total, "nodeCount");
  positiveInteger(layers, "depth");
  if (total < layers) throw new RangeError("nodeCount must be at least depth");
  const sizes = Array(layers).fill(1);
  for (let index = 0; index < total - layers; index += 1) sizes[index % layers] += 1;
  return sizes;
}

function makeGraph(topology, seed, levels, rawEdges) {
  const nodes = levels.flat();
  const levelSizes = levels.map((level) => level.length);
  const known = new Set(nodes);
  const levelOf = new Map(levels.flatMap((level, index) => level.map((id) => [id, index])));
  const edgeKeys = new Set();
  const edges = [];

  for (const edge of rawEdges) {
    if (!edge || typeof edge !== "object" || typeof edge.from !== "string" || typeof edge.to !== "string") {
      throw new TypeError("edges must contain { from, to } objects");
    }
    if (!known.has(edge.from) || !known.has(edge.to)) throw new RangeError("edge references an unknown node");
    if (edge.from === edge.to) throw new RangeError("graph edges must not be self-loops");
    if (levelOf.get(edge.from) >= levelOf.get(edge.to)) throw new RangeError("graph edges must point forward through levels");
    const key = `${edge.from}\u0000${edge.to}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push(Object.freeze({ from: edge.from, to: edge.to }));
  }

  edges.sort((left, right) => {
    const from = left.from < right.from ? -1 : left.from > right.from ? 1 : 0;
    return from || (left.to < right.to ? -1 : left.to > right.to ? 1 : 0);
  });
  const indegree = new Map(nodes.map((id) => [id, 0]));
  const outdegree = new Map(nodes.map((id) => [id, 0]));
  for (const edge of edges) {
    indegree.set(edge.to, indegree.get(edge.to) + 1);
    outdegree.set(edge.from, outdegree.get(edge.from) + 1);
  }
  const roots = nodes.filter((id) => indegree.get(id) === 0);
  const leaves = nodes.filter((id) => outdegree.get(id) === 0);
  const reachable = new Set(roots);
  const queue = [...roots];
  const outgoing = new Map(nodes.map((id) => [id, []]));
  for (const edge of edges) outgoing.get(edge.from).push(edge.to);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    for (const next of outgoing.get(current)) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }

  const frozenLevels = Object.freeze(levels.map((level) => Object.freeze([...level])));
  const hash = stableHash({ topology, seed, nodes, edges });
  const metadata = Object.freeze({
    topology,
    seed,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    depth: levels.length,
    width: levelSizes.reduce((maximum, size) => Math.max(maximum, size), 0),
    levelSizes: Object.freeze(levelSizes),
    roots: Object.freeze([...roots]),
    leaves: Object.freeze([...leaves]),
    connected: reachable.size === nodes.length,
    acyclic: true,
    topologicalOrder: Object.freeze(levels.flat()),
    hash,
    stableHash: hash
  });

  return Object.freeze({
    topology,
    seed,
    nodes: Object.freeze([...nodes]),
    edges: Object.freeze(edges),
    levels: frozenLevels,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    metadata
  });
}

export function generateChain(options = {}) {
  options = optionsObject(options);
  const seed = normalizeSeed(options.seed);
  const count = optionCount(options);
  const levels = layerNodes(Array(count).fill(1));
  const edges = levels.slice(1).map((level, index) => ({ from: levels[index][0], to: level[0] }));
  return makeGraph("chain", seed, levels, edges);
}

export function generateStar(options = {}) {
  options = optionsObject(options);
  const seed = normalizeSeed(options.seed);
  const count = optionCount(options);
  const levels = layerNodes([1, Math.max(0, count - 1)]);
  const edges = levels[1].map((to) => ({ from: levels[0][0], to }));
  return makeGraph("star", seed, levels, edges);
}

export function generateDiamond(options = {}) {
  options = optionsObject(options);
  const seed = normalizeSeed(options.seed);
  const hasBranches = options.branches !== undefined;
  const hasCount = options.nodeCount !== undefined || options.size !== undefined;
  const branches = hasBranches
    ? positiveInteger(options.branches, "branches", 2)
    : optionCount(options, 4) - 2;
  if (hasCount && hasBranches && optionCount(options, 4) !== branches + 2) {
    throw new RangeError("nodeCount must equal branches + 2");
  }
  const levels = layerNodes([1, branches, 1]);
  const root = levels[0][0];
  const sink = levels[2][0];
  const edges = [
    ...levels[1].map((to) => ({ from: root, to })),
    ...levels[1].map((from) => ({ from, to: sink }))
  ];
  return makeGraph("diamond", seed, levels, edges);
}

export function generateDeepDag(options = {}) {
  options = optionsObject(options);
  const seed = normalizeSeed(options.seed);
  const hasCount = options.nodeCount !== undefined || options.size !== undefined;
  const width = positiveInteger(options.width ?? 2, "width");
  const requestedCount = hasCount ? optionCount(options) : undefined;
  const depth = positiveInteger(options.depth ?? (requestedCount === undefined ? 8 : Math.max(2, Math.ceil(requestedCount / width))), "depth", 2);
  const density = probability(options.density, "density", 0.35);
  if (requestedCount !== undefined && requestedCount > depth * width) {
    throw new RangeError("nodeCount cannot exceed depth * width for deep-dag");
  }
  const sizes = requestedCount === undefined ? Array(depth).fill(width) : distribute(requestedCount, depth);
  if (Math.max(...sizes) > width) throw new RangeError("width is too small for nodeCount and depth");
  const levels = layerNodes(sizes);
  const random = createSeededRandom(seed);
  const edges = [];
  for (let index = 1; index < levels.length; index += 1) {
    edges.push(...connectLayerPair(levels[index - 1], levels[index], random, density));
  }
  return makeGraph("deep", seed, levels, edges);
}

export function generateWideDag(options = {}) {
  options = optionsObject(options);
  const seed = normalizeSeed(options.seed);
  const hasCount = options.nodeCount !== undefined || options.size !== undefined;
  const depth = positiveInteger(options.depth ?? 3, "depth", 3);
  const requestedCount = hasCount ? optionCount(options) : undefined;
  const width = options.width === undefined
    ? (requestedCount === undefined ? 8 : Math.max(2, Math.floor((requestedCount - 2) / (depth - 2))))
    : positiveInteger(options.width, "width", 2);
  const density = probability(options.density, "density", 0.35);
  const expectedCount = 2 + width * (depth - 2);
  if (requestedCount !== undefined && requestedCount !== expectedCount) {
    throw new RangeError("nodeCount must equal 2 + width * (depth - 2) for wide-dag");
  }
  const sizes = [1, ...Array(depth - 2).fill(width), 1];
  const levels = layerNodes(sizes);
  const random = createSeededRandom(seed);
  const edges = [];
  for (let index = 1; index < levels.length; index += 1) {
    edges.push(...connectLayerPair(levels[index - 1], levels[index], random, density));
  }
  return makeGraph("wide", seed, levels, edges);
}

export function generateMeshedDag(options = {}) {
  options = optionsObject(options);
  const seed = normalizeSeed(options.seed);
  const count = optionCount(options, 24);
  const depth = positiveInteger(options.depth ?? Math.min(count, Math.max(3, Math.ceil(Math.sqrt(count)))), "depth", 2);
  if (depth > count) throw new RangeError("depth cannot exceed nodeCount");
  const density = probability(options.density, "density", 0.35);
  const levels = layerNodes(distribute(count, depth));
  const random = createSeededRandom(seed);
  const edges = [];
  const crossEdgeBudget = Math.min(50000, count * 8);
  let crossEdges = 0;
  for (let index = 1; index < levels.length; index += 1) {
    edges.push(...connectLayerPair(levels[index - 1], levels[index], random, density));
    const earlier = levels.slice(0, index - 1).flat();
    let stop = false;
    for (const from of earlier) {
      for (const to of levels[index]) {
        if (random() >= density / 2) continue;
        edges.push({ from, to });
        crossEdges += 1;
        if (crossEdges >= crossEdgeBudget) {
          stop = true;
          break;
        }
      }
      if (stop) break;
    }
    if (crossEdges >= crossEdgeBudget) break;
  }
  return makeGraph("mesh", seed, levels, edges);
}

const aliases = Object.freeze({
  chain: generateChain,
  star: generateStar,
  diamond: generateDiamond,
  deep: generateDeepDag,
  wide: generateWideDag,
  mesh: generateMeshedDag,
  "deep-dag": generateDeepDag,
  "wide-dag": generateWideDag,
  "meshed-dag": generateMeshedDag
});

function normalizeTopology(topology) {
  if (typeof topology !== "string" || topology.trim().length === 0) throw new TypeError("topology must be a non-empty string");
  const key = topology.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
  return key === "deepdag" || key === "deep-dag" ? "deep"
    : key === "widedag" || key === "wide-dag" ? "wide"
      : key === "mesheddag" || key === "meshed-dag" ? "mesh"
        : key;
}

function generatorFor(topology) {
  const canonical = normalizeTopology(topology);
  const generator = aliases[canonical];
  if (!generator) throw new RangeError(`unknown topology: ${topology}; expected one of ${TOPOLOGIES.join(", ")}`);
  return generator;
}

export function createGraph(input = {}) {
  const options = optionsObject(input);
  const generator = generatorFor(options.topology);
  return generator({ nodeCount: options.nodeCount, seed: options.seed });
}

export function generateGraph(topology, options = {}) {
  return generatorFor(topology)(options);
}

export const graphGenerators = aliases;
export { TOPOLOGIES };

export const generateDeepDAG = generateDeepDag;
export const generateWideDAG = generateWideDag;
export const generateMeshedDAG = generateMeshedDag;
