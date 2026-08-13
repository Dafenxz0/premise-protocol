import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { IncrementalFrontierEngine } from "../../../../packages/runtime-core/dist/index.js";
import { graphSize, graphTopologies, generateGraph, deterministicRoots } from "./graphs.mjs";
import { ChampionV1Frontier, FullTraversalReference } from "./reference.mjs";

export const FRONTIER_CAMPAIGN_FORMAT = "premise-efficiency-lab/frontier-campaign/v1";
export const FRONTIER_CAMPAIGNS = Object.freeze([
  "validation-amplification", "repeated-dirty-root", "alternating-roots",
  "frontier-query-storm", "multi-target-overlap", "single-flight-stampede",
  "receipt-subsumption", "event-continuity", "long-horizon", "memory-pressure"
]);

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
    frontierCacheEntriesPreserved: left.frontierCacheEntriesPreserved + (right.frontierCacheEntriesPreserved ?? 0)
  };
}

function blank() {
  return { nodesVisited: 0, edgesTraversed: 0, queries: 0, cacheHits: 0, cacheMisses: 0, branchesSkippedAlreadyDirty: 0, frontierCacheInvalidations: 0, frontierCacheEntriesPreserved: 0 };
}

function work(value) {
  return value.nodesVisited + value.edgesTraversed;
}

function locality(affected, total) {
  return total === 0 ? null : affected / total;
}

function oneQuery(engine, champion, reference, target) {
  const actual = engine.frontier(target);
  const championResult = champion.frontier(target);
  const expected = reference.frontier(target);
  if (actual.status !== expected.status || actual.complete !== expected.complete || stable(actual.frontier) !== stable(expected.frontier)) {
    throw new Error(`frontier differential mismatch for ${target}`);
  }
  return {
    actual,
    expected,
    incremental: {
      nodesVisited: actual.nodesVisited,
      edgesTraversed: actual.edgesTraversed,
      queries: 1,
      cacheHits: actual.cacheHit ? 1 : 0,
      cacheMisses: actual.cacheHit ? 0 : 1,
      branchesSkippedAlreadyDirty: 0,
      frontierCacheInvalidations: 0,
      frontierCacheEntriesPreserved: 0
    },
    reference: { nodesVisited: expected.nodesVisited, edgesTraversed: expected.edgesTraversed, queries: 1, cacheHits: 0, cacheMisses: 1, branchesSkippedAlreadyDirty: 0, frontierCacheInvalidations: 0, frontierCacheEntriesPreserved: 0 }
    , champion: { nodesVisited: championResult.nodesVisited, edgesTraversed: championResult.edgesTraversed, queries: 1, cacheHits: championResult.cacheHit ? 1 : 0, cacheMisses: championResult.cacheHit ? 0 : 1, branchesSkippedAlreadyDirty: 0, frontierCacheInvalidations: 0, frontierCacheEntriesPreserved: 0 }
  };
}

function applyMutation(engine, champion, reference, roots, status = "STALE") {
  const actual = engine.markDirty(roots, status);
  const championResult = champion.markDirty(roots, status);
  const expected = reference.markDirty(roots, status);
  if (stable(actual.affected) !== stable(expected.affected)) throw new Error("affected closure mismatch");
  return {
    affected: actual.affected,
    incremental: { nodesVisited: actual.nodesVisited, edgesTraversed: actual.edgesTraversed, queries: 0, cacheHits: 0, cacheMisses: 0, branchesSkippedAlreadyDirty: actual.branchesSkippedAlreadyDirty, frontierCacheInvalidations: actual.frontierCacheInvalidations, frontierCacheEntriesPreserved: actual.frontierCacheEntriesPreserved },
    reference: { nodesVisited: expected.nodesVisited, edgesTraversed: expected.edgesTraversed, queries: 0, cacheHits: 0, cacheMisses: 0, branchesSkippedAlreadyDirty: 0, frontierCacheInvalidations: 0, frontierCacheEntriesPreserved: 0 },
    champion: { nodesVisited: championResult.nodesVisited, edgesTraversed: championResult.edgesTraversed, queries: 0, cacheHits: 0, cacheMisses: 0, branchesSkippedAlreadyDirty: 0, frontierCacheInvalidations: 0, frontierCacheEntriesPreserved: 0 }
  };
}

function scenario(name, nodes, profile, seed) {
  const engine = new IncrementalFrontierEngine(nodes);
  const champion = new ChampionV1Frontier(nodes);
  const reference = new FullTraversalReference(nodes);
  const size = graphSize(nodes);
  const targets = [nodes.at(-1).id, ...nodes.slice(0, Math.min(profile.targetCount, nodes.length)).map(({ id }) => id)];
  let incremental = blank();
  let referenceWork = blank();
  let championWork = blank();
  let affectedCount = 0;
  const add = (event) => {
    incremental = sum(incremental, event.incremental);
    referenceWork = sum(referenceWork, event.reference);
    championWork = sum(championWork, event.champion);
    affectedCount = Math.max(affectedCount, event.affected?.length ?? 0);
  };
  const roots = deterministicRoots(nodes, name === "multi-target-overlap" ? 3 : 1);

  if (name === "validation-amplification") {
    add(applyMutation(engine, champion, reference, roots));
    add(oneQuery(engine, champion, reference, nodes.at(-1).id));
  } else if (name === "repeated-dirty-root") {
    for (let index = 0; index < profile.repetitions; index += 1) {
      add(applyMutation(engine, champion, reference, roots));
      add(oneQuery(engine, champion, reference, nodes.at(-1).id));
    }
  } else if (name === "alternating-roots") {
    const sequence = [nodes[0].id, nodes[Math.floor(nodes.length / 3)].id, nodes[Math.floor(nodes.length / 2)].id, nodes[Math.floor(nodes.length / 3)].id, nodes[0].id];
    for (const root of sequence) {
      add(applyMutation(engine, champion, reference, [root]));
      add(oneQuery(engine, champion, reference, nodes.at(-1).id));
    }
  } else if (name === "frontier-query-storm") {
    add(applyMutation(engine, champion, reference, roots));
    for (let index = 0; index < profile.queryCount; index += 1) add(oneQuery(engine, champion, reference, nodes.at(-1).id));
  } else if (name === "multi-target-overlap") {
    add(applyMutation(engine, champion, reference, roots));
    for (const target of targets.slice(0, profile.targetCount)) add(oneQuery(engine, champion, reference, target));
  } else if (name === "memory-pressure") {
    add(applyMutation(engine, champion, reference, roots));
    for (const target of targets.slice(0, profile.targetCount)) add(oneQuery(engine, champion, reference, target));
  }

  const incrementalWork = work(incremental);
  const championGraphWork = work(championWork);
  const referenceGraphWork = work(referenceWork);
  return Object.freeze({
    campaign: name,
    topology: nodes[0]?.id === "n0" ? "generated" : "unknown",
    seed,
    graph: size,
    relevantAffectedNodes: affectedCount,
    changeLocalityRatio: locality(affectedCount, size.nodes),
    incremental: { ...incremental, graphWork: incrementalWork, runtimeLocalityRatio: locality(incrementalWork, size.nodes + size.edges) },
    champion: { ...championWork, graphWork: championGraphWork, runtimeLocalityRatio: locality(championGraphWork, size.nodes + size.edges) },
    reference: { ...referenceWork, graphWork: referenceGraphWork, runtimeLocalityRatio: locality(referenceGraphWork, size.nodes + size.edges) },
    graphWorkReduction: championGraphWork === 0 ? null : 1 - (incrementalWork / championGraphWork),
    oracleGraphWorkReduction: referenceGraphWork === 0 ? null : 1 - (incrementalWork / referenceGraphWork),
    memory: engine.stats(),
    equivalent: true
  });
}

function profileOf(name) {
  const profile = PROFILES[name];
  if (profile === undefined) throw new RangeError(`Unknown profile: ${name}`);
  return profile;
}

export function runFrontierCampaign({ profile: profileName = "smoke", campaigns = ["validation-amplification", "repeated-dirty-root", "alternating-roots", "frontier-query-storm", "multi-target-overlap", "memory-pressure"], seed = 20260813 } = {}) {
  const profile = profileOf(profileName);
  if (profile.diagnostic) {
    return Object.freeze({ format: FRONTIER_CAMPAIGN_FORMAT, status: "DIAGNOSTIC_NOT_RUN", profile: profileName, requestedNodeCount: profile.nodeCount, requestedCampaigns: campaigns, reason: "diagnostic scale requires dedicated memory and oracle certification" });
  }
  const rows = [];
  for (const campaign of campaigns) {
    if (!["validation-amplification", "repeated-dirty-root", "alternating-roots", "frontier-query-storm", "multi-target-overlap", "memory-pressure"].includes(campaign)) continue;
    for (const topology of graphTopologies()) {
      const nodes = generateGraph({ topology, nodeCount: profile.nodeCount, seed: seed + rows.length });
      const row = scenario(campaign, nodes, profile, seed + rows.length);
      rows.push(Object.freeze({ ...row, topology }));
    }
  }
  const unsupported = ["single-flight-stampede", "receipt-subsumption", "event-continuity", "long-horizon"].map((campaign) => ({ campaign, status: "OUT_OF_SCOPE", reason: "PR23 cycle 1 is frontier-only" }));
  return Object.freeze({
    format: FRONTIER_CAMPAIGN_FORMAT,
    status: "PASS",
    profile: profileName,
    seed,
    baseline: "c86a6ea",
    campaigns: Object.freeze(rows),
    unsupported: Object.freeze(unsupported),
    claims: Object.freeze({ referenceEquivalent: true, safetyClaim: false, commercialClaim: false, diagnosticClaim: false }),
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
  const result = runFrontierCampaign({ profile, seed: Number(args.get("seed") ?? 20260813) });
  const root = resolve(output);
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, `${profile}.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: result.status, profile, rows: result.campaigns?.length ?? 0, output: root }, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("runner.mjs")) await main();
