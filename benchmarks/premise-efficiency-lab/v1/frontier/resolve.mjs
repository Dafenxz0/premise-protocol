import { mkdir, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { IncrementalFrontierEngine } from "../../../../packages/runtime-core/dist/index.js";
import { FullTraversalReference } from "./reference.mjs";

export const RESOLVE_CAMPAIGN_FORMAT = "premise-efficiency-lab/frontier-resolve/v1";

const PROFILES = Object.freeze({
  smoke: Object.freeze({ size: 64 }),
  medium: Object.freeze({ size: 1_000 })
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

function chain(size) {
  return Array.from({ length: size }, (_, index) => ({
    id: `n${index}`,
    dependsOn: index === 0 ? [] : [`n${index - 1}`]
  }));
}

function fanout(size) {
  const leaves = Math.max(4, Math.floor(size / 2));
  return [
    { id: "root" },
    ...Array.from({ length: leaves }, (_, index) => ({ id: `leaf${index}`, dependsOn: ["root"] })),
    { id: "target", dependsOn: Array.from({ length: leaves }, (_, index) => `leaf${index}`) }
  ];
}

function reconvergent(size) {
  const width = Math.max(4, Math.floor(size / 8));
  const layers = Math.max(3, Math.floor(size / width));
  const nodes = [];
  for (let layer = 0; layer < layers; layer += 1) {
    for (let column = 0; column < width; column += 1) {
      const id = `l${layer}c${column}`;
      const dependsOn = layer === 0
        ? []
        : Array.from({ length: Math.min(width, 3) }, (_, offset) => `l${layer - 1}c${(column + offset) % width}`);
      nodes.push({ id, dependsOn });
    }
  }
  nodes.push({ id: "target", dependsOn: Array.from({ length: width }, (_, column) => `l${layers - 1}c${column}`) });
  return nodes;
}

function closure(nodes, roots) {
  const dependents = new Map(nodes.map(({ id }) => [id, []]));
  for (const { id, dependsOn = [] } of nodes) for (const dependency of dependsOn) dependents.get(dependency).push(id);
  const seen = new Set(roots);
  const queue = [...roots];
  for (let index = 0; index < queue.length; index += 1) {
    for (const dependent of dependents.get(queue[index]) ?? []) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      queue.push(dependent);
    }
  }
  return seen;
}

function compare(candidate, reference, target, label) {
  const expected = reference.frontier(target);
  const actual = candidate.frontier(target);
  const same = actual.status === expected.status
    && actual.complete === expected.complete
    && stable(actual.frontier) === stable(expected.frontier);
  if (!same) throw new Error(`resolve differential mismatch (${label}, ${target}): ${JSON.stringify({ actual, expected })}`);
  return actual;
}

function addWork(total, breakdown) {
  if (breakdown === undefined) return total;
  const accountingReconciled = isReconciled(breakdown);
  return {
    maintenance: total.maintenance + breakdown.maintenanceWork,
    query: total.query + breakdown.queryWork,
    total: total.total + breakdown.totalWork,
    reconciled: total.reconciled && accountingReconciled
  };
}

const COUNTER_KEYS = Object.freeze([
  "graphNodeLookups", "graphEdgeTraversals", "reverseIndexLookups", "dirtyStateReads", "dirtyStateWrites",
  "frontierLookups", "frontierRootComparisons", "reachabilityQueries", "reachabilityNodesVisited",
  "reachabilityEdgesTraversed", "cacheLookups", "cacheEntriesScanned", "cacheEntriesPreserved",
  "cacheInvalidations", "cacheWrites", "rootSetReads", "rootSetWrites"
]);
const GRAPH_COUNTER_KEYS = Object.freeze(["graphNodeLookups", "graphEdgeTraversals", "reachabilityNodesVisited", "reachabilityEdgesTraversed"]);

function sumCounters(counters, keys = COUNTER_KEYS) {
  return keys.reduce((sum, key) => sum + counters[key], 0);
}

function isReconciled(breakdown) {
  if (breakdown === undefined || typeof breakdown !== "object") return false;
  const phases = [breakdown.initialization, breakdown.maintenance, breakdown.query];
  if (phases.some((phase) => phase === undefined)) return false;
  if (phases.some((phase) => COUNTER_KEYS.some((key) => !Number.isSafeInteger(phase[key]) || phase[key] < 0))) return false;
  if (phases.some((phase) => phase.cacheEntriesScanned !== phase.cacheInvalidations + phase.cacheEntriesPreserved)) return false;
  return breakdown.initializationWork === sumCounters(breakdown.initialization)
    && breakdown.maintenanceWork === sumCounters(breakdown.maintenance)
    && breakdown.queryWork === sumCounters(breakdown.query)
    && breakdown.initializationGraphWork === sumCounters(breakdown.initialization, GRAPH_COUNTER_KEYS)
    && breakdown.maintenanceGraphWork === sumCounters(breakdown.maintenance, GRAPH_COUNTER_KEYS)
    && breakdown.queryGraphWork === sumCounters(breakdown.query, GRAPH_COUNTER_KEYS)
    && breakdown.totalWork === breakdown.maintenanceWork + breakdown.queryWork
    && breakdown.primitiveWork === breakdown.totalWork
    && breakdown.graphWork === breakdown.maintenanceGraphWork + breakdown.queryGraphWork
    && breakdown.reconciled === true;
}

function runKnownScenario(nodes, topology, requestedSize, seed) {
  const candidate = new IncrementalFrontierEngine(nodes);
  const reference = new FullTraversalReference(nodes);
  const target = nodes.some(({ id }) => id === "target") ? "target" : nodes.at(-1).id;
  const first = nodes[0].id;
  const candidates = nodes.filter(({ id }) => id !== first && id !== target);
  const second = candidates[Math.abs(seed) % Math.max(1, candidates.length)]?.id ?? first;
  const events = [
    { type: "mark", roots: [first, second] },
    { type: "resolve", root: first },
    { type: "resolve", root: target },
    { type: "resolve", root: second },
    { type: "mark", roots: [first] },
    { type: "resolve", root: first }
  ];
  const queried = new Set([target, first, second]);
  let work = { maintenance: 0, query: 0, total: 0, reconciled: true };
  let equivalent = true;
  const observations = [];
  let lastImpact;
  for (const [index, event] of events.entries()) {
    if (event.type === "mark") {
      const actual = candidate.markDirty(event.roots);
      const expected = reference.markDirty(event.roots);
      equivalent = equivalent && stable(actual.affected) === stable(expected.affected) && actual.frontierComplete === true;
      work = addWork(work, actual.workBreakdown);
      lastImpact = actual;
    } else {
      const actual = candidate.resolve(event.root);
      reference.resolve(event.root);
      equivalent = equivalent && actual.frontierComplete === true;
      work = addWork(work, actual.workBreakdown);
      lastImpact = actual;
    }
    const row = {
      step: index,
      event,
      affected: lastImpact?.affected ?? [],
      frontierComplete: lastImpact?.frontierComplete ?? true,
      maintenanceWork: lastImpact?.workBreakdown?.maintenanceWork ?? 0
    };
    for (const query of queried) {
      const result = compare(candidate, reference, query, `${topology}:${index}`);
      work = addWork(work, result.workBreakdown);
      row[query] = { status: result.status, frontier: result.frontier, complete: result.complete, cacheHit: result.cacheHit };
    }
    observations.push(row);
  }
  const stats = candidate.stats();
  return Object.freeze({
    topology,
    requestedSize,
    nodeCount: nodes.length,
    seed,
    target,
    equivalent,
    work,
    resolveMaintenanceWork: observations.filter(({ event }) => event.type === "resolve").reduce((sum, row) => sum + row.maintenanceWork, 0),
    observations: Object.freeze(observations),
    final: observations.at(-1)?.[target] ?? { status: "UNKNOWN", frontier: [], complete: false },
    tombstonedRootCount: stats.tombstonedRootCount,
    tombstonedRootEntries: stats.tombstonedRootEntries,
    frontierBudgetExceeded: stats.frontierBudgetExceeded,
    peakEagerResolveClosure: closure(nodes, [first]).size
  });
}

function runUnknownScenario(nodes) {
  const engine = new IncrementalFrontierEngine(nodes);
  const target = nodes.at(-1).id;
  const root = nodes[0].id;
  engine.markDirty([root], "UNKNOWN");
  const impact = engine.resolve(root);
  const result = engine.frontier(target);
  return Object.freeze({
    status: result.status,
    complete: result.complete,
    frontierComplete: impact.frontierComplete,
    safe: result.status === "UNKNOWN" && result.complete === false && impact.frontierComplete === false
  });
}

export function runResolveCampaign({ profile: profileName = "smoke", seed = 20260813 } = {}) {
  const profile = PROFILES[profileName];
  if (profile === undefined) throw new RangeError(`Unknown profile: ${profileName}`);
  const fixtures = [
    ["chain", chain(profile.size)],
    ["fanout", fanout(profile.size)],
    ["reconvergent", reconvergent(profile.size)]
  ];
  const rows = fixtures.map(([topology, nodes], index) => runKnownScenario(nodes, topology, profile.size, seed + index));
  const unknown = runUnknownScenario(chain(Math.min(profile.size, 64)));
  const claims = Object.freeze({
    referenceEquivalent: rows.every((row) => row.equivalent),
    unknownFailClosed: unknown.safe,
    accountingReconciled: rows.every((row) => row.work.reconciled),
    performanceClaim: false,
    commercialClaim: false
  });
  const result = Object.freeze({
    format: RESOLVE_CAMPAIGN_FORMAT,
    status: claims.referenceEquivalent && claims.unknownFailClosed && claims.accountingReconciled ? "PASS" : "FAIL",
    profile: profileName,
    seed,
    rows: Object.freeze(rows),
    unknown,
    claims,
    notes: Object.freeze([
      "The eager closure size is a locality diagnostic, not a champion performance comparison.",
      "No reduction percentage is claimed until a real, equally instrumented Champion N artifact exists.",
      "Budget exhaustion and UNKNOWN are safety outcomes, never successful optimization outcomes."
    ])
  });
  return Object.freeze({ ...result, reportDigest: digest(result) });
}

async function main() {
  const args = new Map(process.argv.slice(2).map((item) => {
    const [key, value = "true"] = item.replace(/^--/u, "").split("=", 2);
    return [key, value];
  }));
  const profile = args.get("profile") ?? "smoke";
  const output = resolvePath(args.get("output") ?? ".tmp/premise-efficiency-lab/v1/frontier-resolve");
  const result = runResolveCampaign({ profile, seed: Number(args.get("seed") ?? 20260813) });
  await mkdir(output, { recursive: true });
  await writeFile(resolvePath(output, `${profile}.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: result.status, profile, rows: result.rows.length, output }, null, 2)}\n`);
  if (result.status !== "PASS") process.exitCode = 1;
}

if (process.argv[1]?.endsWith("resolve.mjs")) await main();
