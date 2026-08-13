import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { IncrementalFrontierEngine } from "../../../../packages/runtime-core/dist/index.js";
import { graphSize, graphTopologies, generateGraph, deterministicRoots } from "./graphs.mjs";
import { loadBaselineEngine } from "./baseline-artifact.mjs";
import { FullTraversalReference } from "./reference.mjs";

export const FRONTIER_CAMPAIGN_FORMAT = "premise-efficiency-lab/frontier-campaign/v1";
export const FRONTIER_CAMPAIGNS = Object.freeze([
  "validation-amplification", "repeated-dirty-root", "alternating-roots",
  "frontier-query-storm", "multi-target-overlap", "single-flight-stampede",
  "receipt-subsumption", "event-continuity", "long-horizon", "memory-pressure"
]);
const CYCLE_1_CAMPAIGNS = Object.freeze([
  "validation-amplification", "repeated-dirty-root", "alternating-roots",
  "frontier-query-storm", "multi-target-overlap", "memory-pressure"
]);

const PRIMITIVE_COUNTER_KEYS = Object.freeze([
  "graphNodeLookups", "graphEdgeTraversals", "reverseIndexLookups", "dirtyStateReads", "dirtyStateWrites",
  "frontierLookups", "frontierRootComparisons", "reachabilityQueries", "reachabilityCacheLookups", "reachabilityCacheHits",
  "reachabilityCacheMisses", "reachabilityCacheWrites", "reachabilityCacheWriteSkips", "reachabilityCacheEvictions", "reachabilityCacheEntriesCleared", "reachabilityNodesVisited",
  "reachabilityEdgesTraversed", "cacheLookups", "cacheEntriesScanned", "cacheEntriesPreserved",
  "cacheInvalidations", "cacheWrites", "rootSetReads", "rootSetWrites"
]);
const GRAPH_COUNTER_KEYS = Object.freeze(["graphNodeLookups", "graphEdgeTraversals", "reachabilityNodesVisited", "reachabilityEdgesTraversed"]);

const PROFILES = Object.freeze({
  smoke: { nodeCount: 100, repetitions: 4, queryCount: 100, targetCount: 16 },
  medium: { nodeCount: 1_000, repetitions: 10, queryCount: 1_000, targetCount: 100 },
  large: { nodeCount: 10_000, repetitions: 20, queryCount: 10_000, targetCount: 1_000 },
  "diagnostic-xl": { nodeCount: 100_000, repetitions: 50, queryCount: 100_000, targetCount: 10_000, diagnostic: true },
  "diagnostic-xxl": { nodeCount: 1_000_000, repetitions: 100, queryCount: 100_000, targetCount: 10_000, diagnostic: true }
});

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function digest(value) {
  let hash = 2166136261;
  for (const char of stable(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function sum(left, right) {
  return {
    nodesVisited: left.nodesVisited + right.nodesVisited,
    edgesTraversed: left.edgesTraversed + right.edgesTraversed,
    queries: left.queries + right.queries,
    cacheHits: left.cacheHits + right.cacheHits,
    cacheMisses: left.cacheMisses + right.cacheMisses,
    branchesSkippedAlreadyDirty: left.branchesSkippedAlreadyDirty + (right.branchesSkippedAlreadyDirty ?? 0),
    frontierCacheInvalidations: left.frontierCacheInvalidations + (right.frontierCacheInvalidations ?? 0),
    frontierCacheEntriesPreserved: left.frontierCacheEntriesPreserved + (right.frontierCacheEntriesPreserved ?? 0),
    legacyGraphWork: left.legacyGraphWork + (right.legacyGraphWork ?? 0),
    physicalWork: left.physicalWork + (right.physicalWork ?? 0),
    physicalGraphWork: left.physicalGraphWork + (right.physicalGraphWork ?? 0),
    maintenanceWork: left.maintenanceWork + (right.maintenanceWork ?? 0),
    queryWork: left.queryWork + (right.queryWork ?? 0),
    primitiveCounters: addCounters(left.primitiveCounters, right.primitiveCounters),
    accountingReconciled: left.accountingReconciled && right.accountingReconciled
  };
}

function blankCounters() {
  return Object.fromEntries(PRIMITIVE_COUNTER_KEYS.map((key) => [key, 0]));
}

function addCounters(left, right) {
  return Object.fromEntries(PRIMITIVE_COUNTER_KEYS.map((key) => [key, (left?.[key] ?? 0) + (right?.[key] ?? 0)]));
}

function blank() {
  return { nodesVisited: 0, edgesTraversed: 0, queries: 0, cacheHits: 0, cacheMisses: 0, branchesSkippedAlreadyDirty: 0, frontierCacheInvalidations: 0, frontierCacheEntriesPreserved: 0, legacyGraphWork: 0, physicalWork: 0, physicalGraphWork: 0, maintenanceWork: 0, queryWork: 0, primitiveCounters: blankCounters(), accountingReconciled: true };
}

function work(value) {
  return value.nodesVisited + value.edgesTraversed;
}

function locality(affected, total) {
  return total === 0 ? null : affected / total;
}

function physicalDelta(result, fallbackLegacyWork = 0) {
  const breakdown = result?.workBreakdown;
  if (breakdown === undefined) return { physicalWork: 0, maintenanceWork: 0, queryWork: 0, accountingReconciled: false, primitiveCounters: null };
  const phaseWork = (phase) => PRIMITIVE_COUNTER_KEYS.reduce((total, key) => total + phase[key], 0);
  const phaseGraphWork = (phase) => GRAPH_COUNTER_KEYS.reduce((total, key) => total + phase[key], 0);
  const validPhase = (phase) => PRIMITIVE_COUNTER_KEYS.every((key) => Number.isSafeInteger(phase[key]) && phase[key] >= 0)
    && phase.cacheEntriesScanned === phase.cacheInvalidations + phase.cacheEntriesPreserved;
  const phases = [breakdown.initialization, breakdown.maintenance, breakdown.query];
  const reachabilityPhaseReconciled = (phase) =>
    phase.reachabilityQueries === phase.reachabilityCacheLookups
      && phase.reachabilityCacheLookups === phase.reachabilityCacheHits + phase.reachabilityCacheMisses
      && phase.reachabilityCacheMisses === phase.reachabilityCacheWrites + phase.reachabilityCacheWriteSkips;
  const phasesReconciled = phases.every(validPhase)
    && phases.every(reachabilityPhaseReconciled)
    && breakdown.initializationWork === phaseWork(breakdown.initialization)
    && breakdown.maintenanceWork === phaseWork(breakdown.maintenance)
    && breakdown.queryWork === phaseWork(breakdown.query)
    && breakdown.initializationGraphWork === phaseGraphWork(breakdown.initialization)
    && breakdown.maintenanceGraphWork === phaseGraphWork(breakdown.maintenance)
    && breakdown.queryGraphWork === phaseGraphWork(breakdown.query)
    && breakdown.totalWork === breakdown.maintenanceWork + breakdown.queryWork
    && breakdown.primitiveWork === breakdown.totalWork
    && breakdown.graphWork === breakdown.maintenanceGraphWork + breakdown.queryGraphWork;
  const primitiveCounters = addCounters(breakdown.maintenance, breakdown.query);
  const primitiveWork = PRIMITIVE_COUNTER_KEYS.reduce((total, key) => total + primitiveCounters[key], 0);
  const graphWork = GRAPH_COUNTER_KEYS.reduce((total, key) => total + primitiveCounters[key], 0);
  const cacheReconciled = primitiveCounters.cacheEntriesScanned === primitiveCounters.cacheInvalidations + primitiveCounters.cacheEntriesPreserved;
  return {
    physicalWork: primitiveWork,
    physicalGraphWork: graphWork,
    maintenanceWork: breakdown.maintenanceWork,
    queryWork: breakdown.queryWork,
    accountingReconciled: breakdown.reconciled === true && phasesReconciled && primitiveWork === breakdown.maintenanceWork + breakdown.queryWork && graphWork === breakdown.maintenanceGraphWork + breakdown.queryGraphWork && cacheReconciled,
    primitiveCounters
  };
}

function oneQuery(engine, baseline, reference, target) {
  const actual = engine.frontier(target);
  const baselineResult = baseline.frontier(target);
  const expected = reference.frontier(target);
  if (actual.status !== expected.status || actual.complete !== expected.complete || stable(actual.frontier) !== stable(expected.frontier)) {
    throw new Error(`frontier differential mismatch for ${target}`);
  }
  const baselineEquivalent = baselineResult.status === expected.status && baselineResult.complete === expected.complete && stable(baselineResult.frontier) === stable(expected.frontier);
  const candidateWork = physicalDelta(actual);
  return {
    actual,
    expected,
    baselineResult,
    incremental: {
      nodesVisited: actual.nodesVisited,
      edgesTraversed: actual.edgesTraversed,
      queries: 1,
      cacheHits: actual.cacheHit ? 1 : 0,
      cacheMisses: actual.cacheHit ? 0 : 1,
      branchesSkippedAlreadyDirty: 0,
      frontierCacheInvalidations: 0,
      frontierCacheEntriesPreserved: 0,
      legacyGraphWork: work(actual),
      ...candidateWork
    },
    reference: { nodesVisited: expected.nodesVisited, edgesTraversed: expected.edgesTraversed, queries: 1, cacheHits: 0, cacheMisses: 1, branchesSkippedAlreadyDirty: 0, frontierCacheInvalidations: 0, frontierCacheEntriesPreserved: 0, legacyGraphWork: work(expected), physicalWork: 0, maintenanceWork: 0, queryWork: 0, accountingReconciled: true },
    baseline: { nodesVisited: baselineResult.nodesVisited, edgesTraversed: baselineResult.edgesTraversed, queries: 1, cacheHits: baselineResult.cacheHit ? 1 : 0, cacheMisses: baselineResult.cacheHit ? 0 : 1, branchesSkippedAlreadyDirty: 0, frontierCacheInvalidations: 0, frontierCacheEntriesPreserved: 0, legacyGraphWork: work(baselineResult), physicalWork: 0, maintenanceWork: 0, queryWork: 0, accountingReconciled: false }
    , baselineEquivalent
  };
}

function applyMutation(engine, baseline, reference, roots, status = "STALE") {
  const actual = engine.markDirty(roots, status);
  const baselineResult = baseline.markDirty(roots, status);
  const expected = reference.markDirty(roots, status);
  if (stable(actual.affected) !== stable(expected.affected)) throw new Error(`affected closure mismatch: ${JSON.stringify({ roots, actual: actual.affected, expected: expected.affected })}`);
  const baselineEquivalent = stable(baselineResult.affected) === stable(expected.affected);
  const candidateWork = physicalDelta(actual);
  return {
    affected: actual.affected,
    incremental: { nodesVisited: actual.nodesVisited, edgesTraversed: actual.edgesTraversed, queries: 0, cacheHits: 0, cacheMisses: 0, branchesSkippedAlreadyDirty: actual.branchesSkippedAlreadyDirty, frontierCacheInvalidations: actual.frontierCacheInvalidations, frontierCacheEntriesPreserved: actual.frontierCacheEntriesPreserved, legacyGraphWork: work(actual), ...candidateWork },
    reference: { nodesVisited: expected.nodesVisited, edgesTraversed: expected.edgesTraversed, queries: 0, cacheHits: 0, cacheMisses: 0, branchesSkippedAlreadyDirty: 0, frontierCacheInvalidations: 0, frontierCacheEntriesPreserved: 0, legacyGraphWork: work(expected), physicalWork: 0, maintenanceWork: 0, queryWork: 0, accountingReconciled: true },
    baseline: { nodesVisited: baselineResult.nodesVisited, edgesTraversed: baselineResult.edgesTraversed, queries: 0, cacheHits: 0, cacheMisses: 0, branchesSkippedAlreadyDirty: 0, frontierCacheInvalidations: 0, frontierCacheEntriesPreserved: 0, legacyGraphWork: work(baselineResult), physicalWork: 0, maintenanceWork: 0, queryWork: 0, accountingReconciled: false },
    baselineEquivalent
  };
}

function scenario(name, nodes, profile, seed, BaselineEngine) {
  const engine = new IncrementalFrontierEngine(nodes);
  const baseline = new BaselineEngine(nodes);
  const reference = new FullTraversalReference(nodes);
  const size = graphSize(nodes);
  const targets = [nodes.at(-1).id, ...nodes.slice(0, Math.min(profile.targetCount, nodes.length)).map(({ id }) => id)];
  let incremental = blank();
  let referenceWork = blank();
  let baselineWork = blank();
  let affectedCount = 0;
  let baselineEquivalent = true;
  const add = (event) => {
    incremental = sum(incremental, event.incremental);
    referenceWork = sum(referenceWork, event.reference);
    baselineWork = sum(baselineWork, event.baseline);
    baselineEquivalent = baselineEquivalent && event.baselineEquivalent;
    affectedCount = Math.max(affectedCount, event.affected?.length ?? 0);
  };
  const roots = deterministicRoots(nodes, name === "multi-target-overlap" ? 3 : 1);

  if (name === "validation-amplification") {
    add(applyMutation(engine, baseline, reference, roots));
    add(oneQuery(engine, baseline, reference, nodes.at(-1).id));
  } else if (name === "repeated-dirty-root") {
    for (let index = 0; index < profile.repetitions; index += 1) {
      add(applyMutation(engine, baseline, reference, roots));
      add(oneQuery(engine, baseline, reference, nodes.at(-1).id));
    }
  } else if (name === "alternating-roots") {
    const sequence = [nodes[0].id, nodes[Math.floor(nodes.length / 3)].id, nodes[Math.floor(nodes.length / 2)].id, nodes[Math.floor(nodes.length / 3)].id, nodes[0].id];
    for (const root of sequence) {
      add(applyMutation(engine, baseline, reference, [root]));
      add(oneQuery(engine, baseline, reference, nodes.at(-1).id));
    }
  } else if (name === "frontier-query-storm") {
    add(applyMutation(engine, baseline, reference, roots));
    for (let index = 0; index < profile.queryCount; index += 1) add(oneQuery(engine, baseline, reference, nodes.at(-1).id));
  } else if (name === "multi-target-overlap") {
    add(applyMutation(engine, baseline, reference, roots));
    for (const target of targets.slice(0, profile.targetCount)) add(oneQuery(engine, baseline, reference, target));
  } else if (name === "memory-pressure") {
    add(applyMutation(engine, baseline, reference, roots));
    for (const target of targets.slice(0, profile.targetCount)) add(oneQuery(engine, baseline, reference, target));
  }

  const incrementalWork = work(incremental);
  const baselineGraphWork = work(baselineWork);
  const referenceGraphWork = work(referenceWork);
  return Object.freeze({
    campaign: name,
    topology: nodes[0]?.id === "n0" ? "generated" : "unknown",
    seed,
    graph: size,
    relevantAffectedNodes: affectedCount,
    changeLocalityRatio: locality(affectedCount, size.nodes),
    incremental: { ...incremental, graphWork: incrementalWork, runtimeLocalityRatio: locality(incrementalWork, size.nodes + size.edges) },
    baseline: { ...baselineWork, graphWork: baselineGraphWork, runtimeLocalityRatio: locality(baselineGraphWork, size.nodes + size.edges) },
    reference: { ...referenceWork, graphWork: referenceGraphWork, runtimeLocalityRatio: locality(referenceGraphWork, size.nodes + size.edges) },
    physicalComparison: { status: "INCONCLUSIVE_BASELINE_COUNTERS", candidate: incremental.physicalWork, baseline: null, reduction: null },
    memory: engine.stats(),
    equivalent: true,
    baselineEquivalent
  });
}

function profileOf(name) {
  const profile = PROFILES[name];
  if (profile === undefined) throw new RangeError(`Unknown profile: ${name}`);
  return profile;
}

export async function runFrontierCampaign({ profile: profileName = "smoke", campaigns = CYCLE_1_CAMPAIGNS, seed = 20260813 } = {}) {
  const profile = profileOf(profileName);
  if (profile.diagnostic) {
    return Object.freeze({ format: FRONTIER_CAMPAIGN_FORMAT, status: "DIAGNOSTIC_NOT_RUN", profile: profileName, requestedNodeCount: profile.nodeCount, requestedCampaigns: campaigns, reason: "diagnostic scale requires dedicated memory and oracle certification" });
  }
  const requestedCampaigns = [...new Set(campaigns)];
  const unsupportedRequested = requestedCampaigns.filter((campaign) => !CYCLE_1_CAMPAIGNS.includes(campaign));
  if (requestedCampaigns.length !== CYCLE_1_CAMPAIGNS.length || unsupportedRequested.length > 0 || requestedCampaigns.some((campaign, index) => campaign !== CYCLE_1_CAMPAIGNS[index])) {
    return Object.freeze({ format: FRONTIER_CAMPAIGN_FORMAT, status: "INCONCLUSIVE", profile: profileName, seed, requestedCampaigns: campaigns, campaigns: Object.freeze([]), reason: "exact Cycle 1 requires the frozen six-campaign matrix and 36 rows" });
  }
  const baselineArtifact = await loadBaselineEngine();
  const rows = [];
  for (const campaign of campaigns) {
    if (!CYCLE_1_CAMPAIGNS.includes(campaign)) continue;
    for (const topology of graphTopologies()) {
      const nodes = generateGraph({ topology, nodeCount: profile.nodeCount, seed: seed + rows.length });
      const row = scenario(campaign, nodes, profile, seed + rows.length, baselineArtifact.Engine);
      rows.push(Object.freeze({ ...row, topology }));
    }
  }
  if (rows.length !== CYCLE_1_CAMPAIGNS.length * 6) {
    return Object.freeze({ format: FRONTIER_CAMPAIGN_FORMAT, status: "INCONCLUSIVE", profile: profileName, seed, requestedCampaigns: campaigns, campaigns: Object.freeze(rows), reason: `expected ${CYCLE_1_CAMPAIGNS.length * 6} rows, got ${rows.length}` });
  }
  const unsupported = ["single-flight-stampede", "receipt-subsumption", "event-continuity", "long-horizon"].map((campaign) => ({ campaign, status: "OUT_OF_SCOPE", reason: "PR24 evidence cycle is frontier-only" }));
  const referenceEquivalent = rows.every((row) => row.equivalent === true);
  const baselineBehaviorEquivalent = rows.every((row) => row.baselineEquivalent === true);
  const baselineArtifactVerified = baselineArtifact.artifactVerified === true;
  const candidateAccountingReconciled = rows.every((row) => row.incremental.accountingReconciled === true);
  return Object.freeze({
    format: FRONTIER_CAMPAIGN_FORMAT,
    status: referenceEquivalent && baselineArtifactVerified && candidateAccountingReconciled ? "PASS" : "FAIL",
    profile: profileName,
    seed,
    baseline: "c86a6ea",
    baselineArtifact: Object.freeze({
      commit: baselineArtifact.commit,
      artifactDigest: baselineArtifact.artifactDigest,
      artifactFiles: baselineArtifact.artifactFiles,
      protocol: baselineArtifact.manifest.protocol,
      nodeVersion: baselineArtifact.manifest.nodeVersion,
      verified: baselineArtifact.artifactVerified === true
    }),
    campaigns: Object.freeze(rows),
    unsupported: Object.freeze(unsupported),
    claims: Object.freeze({
      referenceEquivalent,
      baselineBehaviorEquivalent,
      baselineArtifactVerified,
      candidateAccountingReconciled,
      baselineComparisonStatus: baselineBehaviorEquivalent ? "PASS" : "INCONCLUSIVE",
      physicalReductionClaim: false,
      safetyClaim: false,
      commercialClaim: false,
      diagnosticClaim: false
    }),
    reportDigest: digest({ profile: profileName, seed, rows, unsupported })
  });
}

async function main() {
  const args = new Map(process.argv.slice(2).map((item) => {
    const [key, value = "true"] = item.replace(/^--/u, "").split("=", 2);
    return [key, value];
  }));
  const profile = args.get("profile") ?? "smoke";
  const output = args.get("output") ?? ".tmp/premise-efficiency-lab/v1/frontier";
  const result = await runFrontierCampaign({ profile, seed: Number(args.get("seed") ?? 20260813) });
  const root = resolve(output);
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, `${profile}.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: result.status, profile, rows: result.campaigns?.length ?? 0, output: root }, null, 2)}\n`);
  if (result.status !== "PASS") process.exitCode = 1;
}

if (process.argv[1]?.endsWith("runner.mjs")) await main();
