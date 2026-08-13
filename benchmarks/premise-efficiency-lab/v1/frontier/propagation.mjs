import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { IncrementalFrontierEngine as CandidateEngine } from "../../../../packages/runtime-core/dist/index.js";
import { artifactDigest, loadBaselineEngine } from "./baseline-artifact.mjs";
import { FullTraversalReference } from "./reference.mjs";

export const PROPAGATION_CAMPAIGN_FORMAT = "premise-efficiency-lab/frontier-propagation/v1";

const PROFILES = Object.freeze({
  smoke: Object.freeze({ chainSize: 128, repeat: 32, alternate: 32, cacheNodes: 96, cacheRepeat: 24, severitySize: 64, roots: 12 }),
  medium: Object.freeze({ chainSize: 1_024, repeat: 160, alternate: 160, cacheNodes: 512, cacheRepeat: 160, severitySize: 256, roots: 24 }),
  full: Object.freeze({ chainSize: 4_096, repeat: 400, alternate: 400, cacheNodes: 2_048, cacheRepeat: 400, severitySize: 1_024, roots: 64 })
});

const COUNTER_KEYS = Object.freeze([
  "graphNodeLookups", "graphEdgeTraversals", "reverseIndexLookups", "dirtyStateReads", "dirtyStateWrites",
  "frontierLookups", "frontierRootComparisons", "reachabilityQueries", "reachabilityNodesVisited",
  "reachabilityEdgesTraversed", "cacheLookups", "cacheEntriesScanned", "cacheEntriesPreserved",
  "cacheInvalidations", "cacheWrites", "rootSetReads", "rootSetWrites"
]);
const GRAPH_COUNTER_KEYS = Object.freeze(["graphNodeLookups", "graphEdgeTraversals", "reachabilityNodesVisited", "reachabilityEdgesTraversed"]);

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

function gitHead(root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "WORKTREE";
  }
}

function pnpmOutput(root, args) {
  if (process.platform === "win32") {
    const command = ["pnpm", ...args].join(" ");
    return execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], { cwd: root, encoding: "utf8" }).trim();
  }
  return execFileSync("pnpm", args, { cwd: root, encoding: "utf8" }).trim();
}

function candidateProvenance(root) {
  let status = "";
  try {
    status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  } catch {
    status = "WORKTREE_STATUS_UNAVAILABLE";
  }
  return Object.freeze({
    commit: gitHead(root),
    dirty: status.length > 0,
    statusEntries: status === "" ? 0 : status.trimEnd().split(/\r?\n/u).length,
    statusDigest: `sha256:${createHash("sha256").update(status).digest("hex")}`,
    nodeVersion: process.versions.node,
    pnpmVersion: pnpmOutput(root, ["--version"]),
    typescriptVersion: pnpmOutput(root, ["exec", "tsc", "--version"])
  });
}

function chain(size, prefix = "n") {
  return Array.from({ length: size }, (_, index) => ({ id: `${prefix}${index}`, dependsOn: index === 0 ? [] : [`${prefix}${index - 1}`] }));
}

function twoBranches(depth) {
  const nodes = [{ id: "a0" }, { id: "b0" }];
  for (let index = 1; index < depth; index += 1) {
    nodes.push({ id: `a${index}`, dependsOn: [`a${index - 1}`] });
    nodes.push({ id: `b${index}`, dependsOn: [`b${index - 1}`] });
  }
  nodes.push({ id: "join", dependsOn: [`a${depth - 1}`, `b${depth - 1}`] });
  nodes.push({ id: "target", dependsOn: ["join"] });
  return nodes;
}

function independent(size) {
  return Array.from({ length: size }, (_, index) => ({ id: `i${index}` }));
}

function fanInRoots(rootCount, branchLength = 4) {
  const nodes = [];
  for (let root = 0; root < rootCount; root += 1) {
    nodes.push({ id: `r${root}` });
    for (let depth = 1; depth < branchLength; depth += 1) {
      nodes.push({ id: `r${root}d${depth}`, dependsOn: [`r${root}${depth === 1 ? "" : `d${depth - 1}`}`] });
    }
  }
  nodes.push({ id: "join", dependsOn: Array.from({ length: rootCount }, (_, root) => `r${root}d${branchLength - 1}`) });
  nodes.push({ id: "target", dependsOn: ["join"] });
  return nodes;
}

function affectedClosure(nodes, roots) {
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
  return [...seen].sort();
}

function blankCounters() {
  return Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0]));
}

function blankCounterBook() {
  return { initialization: blankCounters(), maintenance: blankCounters(), query: blankCounters() };
}

function freezeCounterBook(book) {
  return Object.freeze({
    initialization: Object.freeze({ ...book.initialization }),
    maintenance: Object.freeze({ ...book.maintenance }),
    query: Object.freeze({ ...book.query })
  });
}

function addBreakdownCounters(book, breakdown) {
  for (const phase of ["initialization", "maintenance", "query"]) {
    const source = breakdown?.[phase];
    if (source === undefined) continue;
    for (const key of COUNTER_KEYS) {
      if (Number.isSafeInteger(source[key])) book[phase][key] += source[key];
    }
  }
}

function blankWork() {
  return Object.freeze({ initialization: 0, maintenance: 0, query: 0, total: 0, reconciled: true, operations: 0, counters: freezeCounterBook(blankCounterBook()) });
}

function addWork(total, breakdown) {
  const counters = {
    initialization: { ...total.counters.initialization },
    maintenance: { ...total.counters.maintenance },
    query: { ...total.counters.query }
  };
  addBreakdownCounters(counters, breakdown);
  if (!isReconciled(breakdown)) return Object.freeze({ ...total, reconciled: false, operations: total.operations + 1, counters: freezeCounterBook(counters) });
  return Object.freeze({
    initialization: total.initialization + breakdown.initializationWork,
    maintenance: total.maintenance + breakdown.maintenanceWork,
    query: total.query + breakdown.queryWork,
    total: total.total + breakdown.totalWork,
    reconciled: total.reconciled,
    operations: total.operations + 1,
    counters: freezeCounterBook(counters)
  });
}

function aggregateReconciled(work) {
  const phases = ["initialization", "maintenance", "query"];
  return phases.every((phase) => {
    const counters = work.counters[phase];
    return sumCounters(counters) === work[phase]
      && counters.cacheEntriesScanned === counters.cacheInvalidations + counters.cacheEntriesPreserved;
  }) && work.total === work.maintenance + work.query && work.reconciled === true;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

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

function stateEqual(left, right) {
  return left.status === right.status
    && left.complete === right.complete
    && stable(left.frontier) === stable(right.frontier);
}

function makeScenario(name, nodes, events, warmup, queries, metadata = {}) {
  return Object.freeze({ name, nodes: Object.freeze(nodes), events: Object.freeze(events), warmup: Object.freeze(warmup), queries: Object.freeze(queries), metadata: Object.freeze(metadata) });
}

function scenarios(profile) {
  const chainNodes = chain(profile.chainSize);
  const branches = twoBranches(profile.alternate);
  const cacheNodes = independent(profile.cacheNodes);
  const severityNodes = chain(profile.severitySize, "s");
  const fanIn = fanInRoots(profile.roots);
  const repeatEvents = [
    { type: "mark", roots: ["n0"], status: "STALE" },
    ...Array.from({ length: profile.repeat }, () => ({ type: "mark", roots: ["n0"], status: "STALE" }))
  ];
  const alternateEvents = [
    { type: "mark", roots: ["a0"], status: "STALE" },
    { type: "mark", roots: ["b0"], status: "STALE" },
    ...Array.from({ length: profile.alternate }, (_, index) => ({ type: "mark", roots: [index % 2 === 0 ? "a0" : "b0"], status: "STALE" }))
  ];
  const cacheEvents = [
    { type: "mark", roots: ["i0"], status: "STALE" },
    ...Array.from({ length: profile.cacheRepeat }, () => ({ type: "mark", roots: ["i0"], status: "STALE" }))
  ];
  const severityEvents = [
    { type: "mark", roots: ["s0"], status: "STALE" },
    { type: "mark", roots: ["s0"], status: "UNKNOWN" },
    { type: "mark", roots: ["s0"], status: "INVALID" }
  ];
  const reactivationEvents = [
    { type: "mark", roots: ["a0"], status: "STALE" },
    { type: "resolve", root: "a0" },
    { type: "mark", roots: ["b0"], status: "STALE" },
    { type: "mark", roots: ["a0"], status: "STALE" }
  ];
  const dominatedEvents = [
    { type: "mark", roots: ["r0"], status: "STALE" },
    { type: "mark", roots: ["r1"], status: "STALE" },
    { type: "mark", roots: ["r0"], status: "STALE" }
  ];
  return [
    makeScenario("repeat-root", chainNodes, repeatEvents, [`n${profile.chainSize - 1}`], [`n${profile.chainSize - 1}`], { localityTarget: true }),
    makeScenario("alternate-roots", branches, alternateEvents, ["target"], ["target", "a0", "b0"], { localityTarget: true }),
    makeScenario("cache-locality", cacheNodes, cacheEvents, cacheNodes.map(({ id }) => id), ["i0"], { localityTarget: true }),
    makeScenario("severity-escalation", severityNodes, severityEvents, [`s${profile.severitySize - 1}`], [`s${profile.severitySize - 1}`], { localityTarget: false }),
    makeScenario("reactivation", branches, reactivationEvents, ["target"], ["target", "a0", "b0"], { localityTarget: false }),
    makeScenario("dominated-roots", fanIn, dominatedEvents, ["target"], ["target", "join", "r0d3"], { localityTarget: false })
  ];
}

function materializeScenario(scenario, profile) {
  const replace = (value) => typeof value === "string"
    ? value.replaceAll(/\$\{profile\.(\w+)\}/gu, (_, key) => String(profile[key]))
    : value;
  return Object.freeze({
    ...scenario,
    warmup: Object.freeze(scenario.warmup.map(replace)),
    queries: Object.freeze(scenario.queries.map(replace)),
    events: Object.freeze(scenario.events.map((event) => Object.freeze({ ...event, root: replace(event.root), roots: event.roots?.map(replace) })))
  });
}

function compareImpact(actual, expected, failures, label) {
  if (stable(actual.affected) !== stable(expected.affected)) failures.push(`${label}:affected`);
  if (actual.frontierComplete !== true) failures.push(`${label}:frontier-incomplete`);
}

function runScenario({ scenario, Engine }) {
  const candidate = new CandidateEngine(scenario.nodes);
  const baseline = new Engine(scenario.nodes);
  const reference = new FullTraversalReference(scenario.nodes);
  let candidateWarmupWork = blankWork();
  let baselineWarmupWork = blankWork();
  for (const id of scenario.warmup) {
    candidateWarmupWork = addWork(candidateWarmupWork, candidate.frontier(id).workBreakdown);
    baselineWarmupWork = addWork(baselineWarmupWork, baseline.frontier(id).workBreakdown);
    reference.frontier(id);
  }
  let candidateWork = blankWork();
  let baselineWork = blankWork();
  const failures = [];
  const rows = [];
  for (const [step, event] of scenario.events.entries()) {
    let candidateAction;
    let baselineAction;
    if (event.type === "mark") {
      candidateAction = candidate.markDirty(event.roots, event.status);
      baselineAction = baseline.markDirty(event.roots, event.status);
      const expected = reference.markDirty(event.roots, event.status);
      compareImpact(candidateAction, expected, failures, `${scenario.name}:${step}:candidate`);
      compareImpact(baselineAction, expected, failures, `${scenario.name}:${step}:baseline`);
    } else if (event.type === "resolve") {
      const hadDirect = reference.directDirty.has(event.root);
      const expectedAffected = hadDirect ? affectedClosure(scenario.nodes, [event.root]) : [];
      candidateAction = candidate.resolve(event.root);
      baselineAction = baseline.resolve(event.root);
      reference.resolve(event.root);
      if (stable(candidateAction.affected) !== stable(expectedAffected)) failures.push(`${scenario.name}:${step}:candidate:resolve-affected`);
      if (stable(baselineAction.affected) !== stable(expectedAffected)) failures.push(`${scenario.name}:${step}:baseline:resolve-affected`);
      if (hadDirect && candidateAction.frontierComplete !== true) failures.push(`${scenario.name}:${step}:candidate:resolve-incomplete`);
      if (hadDirect && baselineAction.frontierComplete !== true) failures.push(`${scenario.name}:${step}:baseline:resolve-incomplete`);
    } else {
      throw new Error(`Unknown propagation event: ${event.type}`);
    }
    candidateWork = addWork(candidateWork, candidateAction.workBreakdown);
    baselineWork = addWork(baselineWork, baselineAction.workBreakdown);
    const observations = [];
    for (const target of scenario.queries) {
      const candidateResult = candidate.frontier(target);
      const baselineResult = baseline.frontier(target);
      const referenceResult = reference.frontier(target);
      candidateWork = addWork(candidateWork, candidateResult.workBreakdown);
      baselineWork = addWork(baselineWork, baselineResult.workBreakdown);
      const skipReferenceAfterUnknownResolve = event.type === "resolve"
        && candidateAction.frontierComplete === false
        && candidateResult.complete === false;
      if (!skipReferenceAfterUnknownResolve) {
        if (!stateEqual(candidateResult, referenceResult)) failures.push(`${scenario.name}:${step}:${target}:candidate:state`);
        if (!stateEqual(baselineResult, referenceResult)) failures.push(`${scenario.name}:${step}:${target}:baseline:state`);
      }
      observations.push(Object.freeze({
        target,
        candidate: { status: candidateResult.status, frontier: candidateResult.frontier, complete: candidateResult.complete, cacheHit: candidateResult.cacheHit },
        baseline: { status: baselineResult.status, frontier: baselineResult.frontier, complete: baselineResult.complete, cacheHit: baselineResult.cacheHit },
        reference: { status: referenceResult.status, frontier: referenceResult.frontier, complete: referenceResult.complete }
      }));
    }
    rows.push(Object.freeze({
      step,
      event,
      candidateAction: { affected: candidateAction.affected, frontierComplete: candidateAction.frontierComplete, work: candidateAction.workBreakdown },
      baselineAction: { affected: baselineAction.affected, frontierComplete: baselineAction.frontierComplete, work: baselineAction.workBreakdown },
      observations
    }));
  }
  const candidateStats = candidate.stats();
  const baselineStats = baseline.stats();
  const candidatePhysicalWork = candidateWork.total;
  const baselinePhysicalWork = baselineWork.total;
  const accountingReconciled = candidateWork.reconciled && baselineWork.reconciled && aggregateReconciled(candidateWork) && aggregateReconciled(baselineWork);
  const comparable = failures.length === 0 && accountingReconciled && candidatePhysicalWork > 0 && baselinePhysicalWork > 0;
  const reduction = comparable ? (baselinePhysicalWork - candidatePhysicalWork) / baselinePhysicalWork : null;
  return Object.freeze({
    name: scenario.name,
    nodeCount: scenario.nodes.length,
    eventCount: scenario.events.length,
    queryCount: scenario.events.length * scenario.queries.length,
    localityTarget: scenario.metadata.localityTarget === true,
    failures: Object.freeze(failures),
    equivalent: failures.length === 0,
    accountingReconciled,
    comparable,
    warmupWork: Object.freeze({ candidate: candidateWarmupWork, baseline: baselineWarmupWork }),
    candidateWork,
    baselineWork,
    candidatePhysicalWork,
    baselinePhysicalWork,
    reduction,
    candidateStats: {
      trusted: candidateStats.trusted,
      frontierBudgetExceeded: candidateStats.frontierBudgetExceeded,
      tombstonedRootEntries: candidateStats.tombstonedRootEntries,
      affectedClosureCacheEntries: candidateStats.affectedClosureCacheEntries,
      affectedClosureCacheNodes: candidateStats.affectedClosureCacheNodes,
      affectedClosureCacheEvictions: candidateStats.affectedClosureCacheEvictions
    },
    baselineStats: { trusted: baselineStats.trusted, frontierBudgetExceeded: baselineStats.frontierBudgetExceeded, tombstonedRootEntries: baselineStats.tombstonedRootEntries },
    observations: Object.freeze(rows)
  });
}

function runExhaustiveLane(scenariosToCheck, Engine) {
  const failures = [];
  for (const scenario of scenariosToCheck) {
    const candidate = new CandidateEngine(scenario.nodes);
    const baseline = new Engine(scenario.nodes);
    const reference = new FullTraversalReference(scenario.nodes);
    for (const id of scenario.warmup) {
      candidate.frontier(id);
      baseline.frontier(id);
      reference.frontier(id);
    }
    for (const [step, event] of scenario.events.entries()) {
      if (event.type === "mark") {
        const candidateImpact = candidate.markDirty(event.roots, event.status);
        const baselineImpact = baseline.markDirty(event.roots, event.status);
        const expected = reference.markDirty(event.roots, event.status);
        compareImpact(candidateImpact, expected, failures, `${scenario.name}:${step}:exhaustive:candidate`);
        compareImpact(baselineImpact, expected, failures, `${scenario.name}:${step}:exhaustive:baseline`);
      } else {
        const hadDirect = reference.directDirty.has(event.root);
        const expectedAffected = hadDirect ? affectedClosure(scenario.nodes, [event.root]) : [];
        const candidateImpact = candidate.resolve(event.root);
        const baselineImpact = baseline.resolve(event.root);
        reference.resolve(event.root);
        if (stable(candidateImpact.affected) !== stable(expectedAffected)) failures.push(`${scenario.name}:${step}:exhaustive:candidate:resolve`);
        if (stable(baselineImpact.affected) !== stable(expectedAffected)) failures.push(`${scenario.name}:${step}:exhaustive:baseline:resolve`);
      }
      const unknownResolve = event.type === "resolve"
        && candidate.frontier(scenario.nodes[0].id).complete === false;
      for (const { id } of scenario.nodes) {
        const candidateResult = candidate.frontier(id);
        const baselineResult = baseline.frontier(id);
        const referenceResult = reference.frontier(id);
        if (unknownResolve) {
          if (candidateResult.status !== "UNKNOWN" || candidateResult.complete !== false) failures.push(`${scenario.name}:${step}:${id}:exhaustive:candidate:unknown`);
          if (baselineResult.status !== "UNKNOWN" || baselineResult.complete !== false) failures.push(`${scenario.name}:${step}:${id}:exhaustive:baseline:unknown`);
        } else {
          if (!stateEqual(candidateResult, referenceResult)) failures.push(`${scenario.name}:${step}:${id}:exhaustive:candidate:state`);
          if (!stateEqual(baselineResult, referenceResult)) failures.push(`${scenario.name}:${step}:${id}:exhaustive:baseline:state`);
        }
      }
    }
  }
  return Object.freeze({ status: failures.length === 0 ? "PASS" : "FAIL", failures: Object.freeze(failures) });
}

function runUnknownSafety(nodes, Engine) {
  const candidate = new CandidateEngine(nodes);
  const baseline = new Engine(nodes);
  const root = nodes[0].id;
  const target = nodes.at(-1).id;
  candidate.markDirty([root], "UNKNOWN");
  baseline.markDirty([root], "UNKNOWN");
  const candidateImpact = candidate.resolve(root);
  const baselineImpact = baseline.resolve(root);
  const candidateResult = candidate.frontier(target);
  const baselineResult = baseline.frontier(target);
  return Object.freeze({
    candidate: { status: candidateResult.status, complete: candidateResult.complete, frontierComplete: candidateImpact.frontierComplete },
    baseline: { status: baselineResult.status, complete: baselineResult.complete, frontierComplete: baselineImpact.frontierComplete },
    safe: candidateResult.status === "UNKNOWN" && candidateResult.complete === false && candidateImpact.frontierComplete === false
      && baselineResult.status === "UNKNOWN" && baselineResult.complete === false && baselineImpact.frontierComplete === false
  });
}

function runBudgetSafety() {
  const nodes = [];
  const rootCount = 200;
  const joinCount = 200;
  const roots = Array.from({ length: rootCount }, (_, index) => `r${index}`);
  for (const id of roots) nodes.push({ id });
  for (let index = 0; index < joinCount; index += 1) nodes.push({ id: `j${index}`, dependsOn: roots });
  nodes.push({ id: "target", dependsOn: Array.from({ length: joinCount }, (_, index) => `j${index}`) });
  const candidate = new CandidateEngine(nodes);
  const impact = candidate.markDirty(roots, "STALE");
  const result = candidate.frontier("target");
  return Object.freeze({
    rootCount,
    joinCount,
    frontierComplete: impact.frontierComplete,
    status: result.status,
    complete: result.complete,
    safe: impact.frontierComplete === false && result.status === "UNKNOWN" && result.complete === false
  });
}

export async function runPropagationCampaign({ profile: profileName = "smoke", seed = 20260813, root = process.cwd() } = {}) {
  const profile = PROFILES[profileName];
  if (profile === undefined) throw new RangeError(`Unknown profile: ${profileName}`);
  const baseline = await loadBaselineEngine({ manifestFile: new URL("./pr27-baseline-manifest.json", import.meta.url) });
  const candidateArtifact = await artifactDigest(root);
  const candidate = candidateProvenance(root);
  const rawScenarios = scenarios(profile).map((scenario) => materializeScenario(scenario, profile));
  const rows = rawScenarios.map((scenario) => runScenario({ scenario, Engine: baseline.Engine }));
  const exhaustive = profileName === "smoke"
    ? runExhaustiveLane(rawScenarios, baseline.Engine)
    : Object.freeze({ status: "NOT_RUN", failures: Object.freeze([]), reason: "medium/full profiles are diagnostic and preserve the smoke exhaustive gate" });
  const unknown = runUnknownSafety(chain(Math.min(profile.severitySize, 64), "u"), baseline.Engine);
  const budget = runBudgetSafety();
  const localityRows = rows.filter((row) => row.localityTarget && row.comparable);
  const localityReductions = localityRows.map(({ reduction }) => reduction).filter((reduction) => reduction !== null);
  const localityMedianReduction = median(localityReductions);
  const performanceGate = localityRows.length > 0
    && localityRows.length === 3
    && localityMedianReduction !== null
    && localityMedianReduction >= 0.20
    && localityRows.every((row) => row.reduction !== null && row.reduction >= -0.05);
  const claims = Object.freeze({
    baselineArtifactVerified: baseline.artifactVerified === true,
    referenceEquivalent: rows.every((row) => row.equivalent),
    accountingReconciled: rows.every((row) => row.accountingReconciled),
    allRowsComparable: rows.every((row) => row.comparable),
    unknownFailClosed: unknown.safe,
    budgetFailClosed: budget.safe,
    exhaustiveReferenceEquivalent: exhaustive.status === "PASS",
    localityRowsComparable: localityRows.length === 3,
    localityMedianReduction,
    localityPerformanceGate: performanceGate,
    performanceClaim: performanceGate,
    commercialClaim: false
  });
  const correctness = claims.baselineArtifactVerified && claims.referenceEquivalent && claims.accountingReconciled && claims.unknownFailClosed && claims.budgetFailClosed
    && (profileName !== "smoke" || claims.exhaustiveReferenceEquivalent);
  const status = !correctness ? "FAIL" : !claims.localityPerformanceGate ? "INCONCLUSIVE" : "PASS";
  const result = Object.freeze({
    format: PROPAGATION_CAMPAIGN_FORMAT,
    status,
    profile: profileName,
    seed,
    candidate: Object.freeze({ ...candidate, artifactDigest: candidateArtifact.digest, artifactFiles: candidateArtifact.files, buildCommand: "pnpm build" }),
    baseline: Object.freeze({ commit: baseline.commit, artifactDigest: baseline.artifactDigest, artifactFiles: baseline.artifactFiles, manifest: baseline.manifest }),
    rows: Object.freeze(rows),
    exhaustive,
    unknown,
    budget,
    claims,
    notes: Object.freeze([
      "Primitive work is the sum of all 17 instrumented counters over maintenance and query phases; initialization is reported separately by each breakdown.",
      "The FullTraversalReference is a semantic oracle only. It is never used as a physical-work denominator.",
      "The champion is the exact compiled artifact at the PR27 baseline manifest commit, not a hand-written reconstruction.",
      "This is a deterministic calibration campaign, not a blind external evaluation. No tokens, provider cost, external reads or commercial savings are claimed.",
      "INCONCLUSIVE means behavior and accounting passed but the targeted performance gate did not; it is not a performance win."
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
  const output = resolvePath(args.get("output") ?? ".tmp/premise-efficiency-lab/v1/frontier-propagation");
  const result = await runPropagationCampaign({ profile, seed: Number(args.get("seed") ?? 20260813), root: process.cwd() });
  await mkdir(output, { recursive: true });
  await writeFile(resolvePath(output, `${profile}.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: result.status, profile: result.profile, rows: result.rows.length, output }, null, 2)}\n`);
  if (result.status !== "PASS") process.exitCode = 1;
}

if (process.argv[1]?.endsWith("propagation.mjs")) await main();
