import { createHash } from "node:crypto";
import { generateGraph } from "./graphs.mjs";
import { FullTraversalReference } from "./reference.mjs";
import { loadBaselineEngine } from "./baseline-artifact.mjs";
import { IncrementalFrontierEngine } from "../../../../packages/runtime-core/dist/index.js";

const PRIMITIVE_COUNTER_KEYS = Object.freeze([
  "graphNodeLookups", "graphEdgeTraversals", "reverseIndexLookups", "dirtyStateReads", "dirtyStateWrites",
  "frontierLookups", "frontierRootComparisons", "reachabilityQueries", "reachabilityCacheLookups",
  "reachabilityCacheHits", "reachabilityCacheMisses", "reachabilityCacheWrites", "reachabilityCacheEvictions", "reachabilityCacheEntriesCleared",
  "reachabilityNodesVisited", "reachabilityEdgesTraversed", "cacheLookups", "cacheEntriesScanned",
  "cacheEntriesPreserved", "cacheInvalidations", "cacheWrites", "rootSetReads", "rootSetWrites"
]);
const ZERO_DEFAULT_COUNTER_KEYS = Object.freeze([
  "reachabilityCacheLookups", "reachabilityCacheHits", "reachabilityCacheMisses",
  "reachabilityCacheWrites", "reachabilityCacheEvictions", "reachabilityCacheEntriesCleared"
]);
const EXPECTED_CHAMPION_MANIFEST = Object.freeze({
  commit: "56f380307f4eada9f5bb5223e0fe739f76f0a862",
  artifactDigest: "sha256:d8ef1c67d2390f541db166500f75d4e8fc35923bd8c58d4936021b402cd41be7",
  artifactFileCount: 36,
  artifactExclude: ["**/tsconfig.tsbuildinfo"],
  artifactPaths: ["packages/runtime-core/dist", "packages/protocol-types/dist"],
  nodeVersion: "24",
  pnpmVersion: "10.13.1",
  typescriptVersion: "7.0.2",
  protocol: "premise/1.1",
  campaign: "frontier-cycle-2-pr25-champion",
  buildCommand: "pnpm build"
});

function reconvergent(rootCount) {
  const nodes = [];
  const roots = [];
  for (let index = 0; index < rootCount; index += 1) {
    const source = `s${index}`;
    const root = `r${index}`;
    nodes.push({ id: source }, { id: root, dependsOn: [source] });
    roots.push(root);
  }
  nodes.push({ id: "shared", dependsOn: roots }, { id: "target", dependsOn: ["shared"] });
  return { nodes: Object.freeze(nodes), roots: Object.freeze(roots) };
}

function fixture(topology, rootCount, seed) {
  if (topology === "reconvergent") return reconvergent(rootCount);
  const nodeCount = topology === "nested-diamond"
    ? Math.max(1_000, rootCount * 3 + 10)
    : Math.max(1_000, rootCount + 2);
  const nodes = generateGraph({ topology, nodeCount, seed });
  const roots = nodes.slice(0, Math.min(rootCount, nodes.length - 1)).map(({ id }) => id);
  return { nodes, roots: Object.freeze(roots) };
}

function orderRoots(roots, order) {
  if (order === "forward") return [...roots];
  if (order === "reverse") return [...roots].reverse();
  if (order === "interleaved") {
    const output = [];
    let left = 0;
    let right = roots.length - 1;
    while (left <= right) {
      output.push(roots[left]);
      if (left !== right) output.push(roots[right]);
      left += 1;
      right -= 1;
    }
    return output;
  }
  throw new RangeError(`unsupported root order: ${order}`);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function countersFromBreakdowns(breakdowns) {
  const counters = Object.fromEntries(PRIMITIVE_COUNTER_KEYS.map((key) => [key, 0]));
  for (const breakdown of breakdowns) {
    if (breakdown === undefined || breakdown === null) continue;
    for (const phase of [breakdown.maintenance, breakdown.query]) {
      if (phase === undefined || phase === null) continue;
      for (const key of PRIMITIVE_COUNTER_KEYS) counters[key] += phase[key] ?? 0;
    }
  }
  return counters;
}

function accountingReconciled(breakdowns, implementation) {
  return breakdowns.every((breakdown) => {
    if (breakdown === undefined || breakdown === null) return false;
    const phases = [breakdown.initialization, breakdown.maintenance, breakdown.query];
    const validPhase = (phase) => phase !== undefined
      && PRIMITIVE_COUNTER_KEYS.every((key) => {
        const value = phase[key];
        return (value === undefined && implementation === "champion" && ZERO_DEFAULT_COUNTER_KEYS.includes(key))
          || (Number.isSafeInteger(value) && value >= 0);
      })
      && (phase.cacheEntriesScanned ?? 0) === (phase.cacheInvalidations ?? 0) + (phase.cacheEntriesPreserved ?? 0);
    const phaseWork = (phase) => PRIMITIVE_COUNTER_KEYS.reduce((total, key) => total + (phase?.[key] ?? 0), 0);
    const phaseGraphWork = (phase) => ["graphNodeLookups", "graphEdgeTraversals", "reachabilityNodesVisited", "reachabilityEdgesTraversed"]
      .reduce((total, key) => total + (phase?.[key] ?? 0), 0);
    const initializationWork = phaseWork(phases[0]);
    const maintenanceWork = phaseWork(phases[1]);
    const queryWork = phaseWork(phases[2]);
    const initializationGraphWork = phaseGraphWork(phases[0]);
    const maintenanceGraphWork = phaseGraphWork(phases[1]);
    const queryGraphWork = phaseGraphWork(phases[2]);
    const primitiveWork = maintenanceWork + queryWork;
    const graphWork = maintenanceGraphWork + queryGraphWork;
    const summaryFields = [
      breakdown.initializationWork, breakdown.maintenanceWork, breakdown.queryWork,
      breakdown.totalWork, breakdown.initializationGraphWork, breakdown.maintenanceGraphWork,
      breakdown.queryGraphWork, breakdown.graphWork, breakdown.primitiveWork
    ];
    return breakdown.reconciled === true
      && phases.every(validPhase)
      && summaryFields.every((value) => Number.isSafeInteger(value) && value >= 0)
      && breakdown.initializationWork === initializationWork
      && breakdown.maintenanceWork === maintenanceWork
      && breakdown.queryWork === queryWork
      && breakdown.totalWork === maintenanceWork + queryWork
      && breakdown.initializationGraphWork === initializationGraphWork
      && breakdown.maintenanceGraphWork === maintenanceGraphWork
      && breakdown.queryGraphWork === queryGraphWork
      && breakdown.graphWork === graphWork
      && breakdown.primitiveWork === primitiveWork;
  });
}

function runEngine(Engine, nodes, roots, target, implementation) {
  const rssBefore = process.memoryUsage().rss;
  const engine = new Engine(nodes);
  const started = process.hrtime.bigint();
  const impact = engine.markDirty(roots);
  const result = engine.frontier(target);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const rssAfter = process.memoryUsage().rss;
  const stats = typeof engine.stats === "function" ? engine.stats() : null;
  const breakdowns = [impact.workBreakdown, result.workBreakdown];
  const counters = countersFromBreakdowns(breakdowns);
  const presentKeys = new Set();
  for (const breakdown of breakdowns) for (const phase of [breakdown?.maintenance, breakdown?.query]) {
    for (const key of PRIMITIVE_COUNTER_KEYS) if (phase?.[key] !== undefined) presentKeys.add(key);
  }
  const missingKeys = PRIMITIVE_COUNTER_KEYS.filter((key) => !presentKeys.has(key));
  const counterContract = Object.freeze({
    format: "premise-efficiency-lab/frontier-physical/v1",
    complete: missingKeys.length === 0,
    normalized: missingKeys.every((key) => implementation === "champion" && ZERO_DEFAULT_COUNTER_KEYS.includes(key)),
    knownBaselineNoCache: implementation === "champion" && missingKeys.length > 0 && missingKeys.every((key) => ZERO_DEFAULT_COUNTER_KEYS.includes(key)),
    missingKeys: Object.freeze(missingKeys),
    zeroDefaultsApplied: Object.freeze(missingKeys.map((key) => ({ key, value: 0 })))
  });
  const physicalWork = PRIMITIVE_COUNTER_KEYS.reduce((sum, key) => sum + counters[key], 0);
  const graphWork = counters.graphNodeLookups
    + counters.graphEdgeTraversals
    + counters.reachabilityNodesVisited
    + counters.reachabilityEdgesTraversed;
  const accounting = accountingReconciled(breakdowns, implementation);
  const complete = result.complete === true
    && (implementation === "champion" || impact.frontierComplete === true);
  return Object.freeze({
    status: complete && accounting ? "PASS" : "INCONCLUSIVE",
    reason: !complete ? "frontier budget or trust state incomplete" : accounting ? undefined : "physical counter accounting did not reconcile",
    elapsedMs: Number(elapsedMs.toFixed(3)),
    rssDeltaBytes: Math.max(0, rssAfter - rssBefore),
    affectedCount: impact.affected.length,
    affectedDigest: digest(impact.affected),
    frontierCount: result.frontier.length,
    frontierDigest: digest(result.frontier),
    decision: { status: result.status, complete: result.complete },
    physicalWork,
    graphWork,
    accountingReconciled: accounting,
    counterContract,
    reachabilityCache: {
      entries: stats?.reachabilityCacheEntries ?? null,
      limit: stats?.reachabilityCacheLimit ?? null
    },
    frontierBudget: {
      exceeded: stats?.frontierBudgetExceeded ?? null,
      limit: stats?.frontierRootComparisonBudget ?? null
    },
    counters
  });
}

const args = new Map(process.argv.slice(2).map((item) => {
  const [key, value = "true"] = item.replace(/^--/u, "").split("=", 2);
  return [key, value];
}));
const topology = args.get("topology") ?? "nested-diamond";
const rootCount = Number(args.get("roots") ?? 100);
const seed = Number(args.get("seed") ?? 20260813);
const implementation = args.get("implementation") ?? "candidate";
const rootOrder = args.get("order") ?? "forward";
if (!Number.isSafeInteger(rootCount) || rootCount < 1) throw new RangeError("roots must be a positive integer");
if (!["nested-diamond", "meshed", "reconvergent", "wide"].includes(topology)) throw new RangeError(`unsupported topology: ${topology}`);

const { nodes, roots } = fixture(topology, rootCount, seed);
const orderedRoots = orderRoots(roots, rootOrder);
const target = nodes.at(-1).id;
const Engine = implementation === "candidate"
  ? IncrementalFrontierEngine
  : (await loadBaselineEngine({
    manifestFile: new URL("./champion-manifest.json", import.meta.url),
    expectedManifest: EXPECTED_CHAMPION_MANIFEST,
    worktreeLabel: "champion"
  })).Engine;
const metrics = runEngine(Engine, nodes, orderedRoots, target, implementation);
let output = metrics;

if (implementation === "candidate" && rootCount <= 128) {
  const reference = new FullTraversalReference(nodes);
  const expectedImpact = reference.markDirty(roots);
  const expectedFrontier = reference.frontier(target);
  const referenceResult = {
    affectedCount: expectedImpact.affected.length,
    affectedDigest: digest(expectedImpact.affected),
    frontierCount: expectedFrontier.frontier.length,
    frontierDigest: digest(expectedFrontier.frontier),
    decision: { status: expectedFrontier.status, complete: expectedFrontier.complete }
  };
  output = {
    ...metrics,
    reference: referenceResult,
    referenceEquivalent: metrics.affectedCount === referenceResult.affectedCount
      && metrics.affectedDigest === referenceResult.affectedDigest
      && metrics.frontierCount === referenceResult.frontierCount
      && metrics.frontierDigest === referenceResult.frontierDigest
      && metrics.decision.status === referenceResult.decision.status
      && metrics.decision.complete === referenceResult.decision.complete
  };
}

process.stdout.write(`${JSON.stringify({
  format: "premise-efficiency-lab/frontier-root-explosion-case/v1",
  topology,
  rootCount,
  actualRootCount: orderedRoots.length,
  rootOrder,
  nodeCount: nodes.length,
  implementation,
  target,
  ...output
})}\n`);
