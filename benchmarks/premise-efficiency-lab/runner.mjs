import { fileURLToPath } from "node:url";
import { generateGraph, TOPOLOGIES } from "./generators/graphs.mjs";
import { affectedSet } from "./oracle/affected-set.mjs";
import { minimumWork } from "./oracle/minimum-work.mjs";
import { createMutationEvents, normalizeMutationEvents } from "./generators/events.mjs";
import { aggregateCandidateResults } from "./harness/metrics.mjs";
import { createCounters } from "./harness/counters.mjs";
import { anonymizeCandidates, createSealedManifest, evaluateBlind } from "./referee/blind-evaluator.mjs";

const DEFAULT_TASKS = 100;
const DEFAULT_SEED = 20260812;
const CANDIDATES = Object.freeze(["memory", "smart", "always", "premise"]);

function parseArgs(argv) {
  const result = { tasks: DEFAULT_TASKS, seed: DEFAULT_SEED, volatility: 0.25, nodeCount: 100 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const [key, inline] = value.split("=", 2);
    const next = inline ?? argv[index + 1];
    if (key === "--tasks" && inline === undefined) index += 1;
    if (key === "--seed" && inline === undefined) index += 1;
    if (key === "--volatility" && inline === undefined) index += 1;
    if (key === "--nodes" && inline === undefined) index += 1;
    if (key === "--tasks") result.tasks = Number(next);
    if (key === "--seed") result.seed = Number(next);
    if (key === "--volatility") result.volatility = Number(next);
    if (key === "--nodes") result.nodeCount = Number(next);
  }
  if (!Number.isSafeInteger(result.tasks) || result.tasks < 1) throw new RangeError("--tasks must be a positive integer");
  if (!Number.isSafeInteger(result.seed)) throw new RangeError("--seed must be an integer");
  if (!Number.isFinite(result.volatility) || result.volatility < 0 || result.volatility > 1) throw new RangeError("--volatility must be between 0 and 1");
  if (!Number.isSafeInteger(result.nodeCount) || result.nodeCount < 4) throw new RangeError("--nodes must be an integer >= 4");
  return result;
}

function hashRandom(seed) {
  let state = (Math.trunc(seed) >>> 0) || 0x9e3779b9;
  return () => {
    state = Math.imul(state ^ (state >>> 16), 0x45d9f3b) >>> 0;
    state = Math.imul(state ^ (state >>> 16), 0x45d9f3b) >>> 0;
    return ((state ^ (state >>> 16)) >>> 0) / 4294967296;
  };
}

function pick(random, values) {
  return values[Math.floor(random() * values.length)];
}

function riskFor(index) {
  return ["low", "medium", "high", "critical"][index % 4];
}

function isHighRisk(risk) {
  return risk === "high" || risk === "critical";
}

function emptyRecord() {
  return {
    completed: 0,
    safeCompletions: 0,
    unsafeActions: 0,
    toctouEscapes: 0,
    crossTenantReuse: 0,
    sourceReads: 0,
    reads: 0,
    writes: 0,
    requests: 0,
    eventSignals: 0,
    validations: 0,
    externalWork: 0,
    graphWork: 0,
    protocolWork: 0,
    nodes: 0,
    edges: 0,
    frontier: 0,
    dependencies: 0,
    invalidations: 0,
    reuse: 0,
    batching: 0,
    incrementality: 0,
    minimumWork: 0,
    mutatedAffected: 0,
    staleDetections: 0,
    staleRecoveries: 0,
    latencyMs: 0
  };
}

function mutationFor(graph, random, volatility, index) {
  if (random() >= volatility) return {
    changed: false,
    changedNodes: [],
    affected: new Set(),
    schedule: "isolated",
    evidence: normalizeMutationEvents([])
  };
  const schedules = ["isolated", "simultaneous", "burst", "duplicate", "reordered", "gapped"];
  const schedule = schedules[index % schedules.length];
  const count = schedule === "isolated" ? 1 : schedule === "gapped" ? 3 : schedule === "burst" ? 3 : 2;
  const changedNodes = [];
  while (changedNodes.length < count) {
    const node = pick(random, graph.nodes);
    if (!changedNodes.includes(node)) changedNodes.push(node);
  }
  const stream = createMutationEvents({ nodeIds: changedNodes, schedule, seed: `${index}:${changedNodes.join(",")}` });
  return {
    changed: true,
    changedNodes,
    affected: affectedSet(graph, changedNodes),
    schedule,
    evidence: normalizeMutationEvents(stream)
  };
}

function buildCases(options) {
  const random = hashRandom(options.seed);
  const topologies = options.topologies ?? TOPOLOGIES;
  return Array.from({ length: options.tasks }, (_, index) => {
    const topology = topologies[index % topologies.length];
    const graph = generateGraph(topology, { nodeCount: options.nodeCount, seed: `${options.seed}:${index}` });
    const target = pick(random, graph.nodes.slice(Math.max(0, graph.nodes.length - Math.min(8, graph.nodes.length))));
    const risk = riskFor(index);
    const mutation = mutationFor(graph, random, options.volatility, index);
    return Object.freeze({ index, topology, graph, target, risk, mutation, affectedTarget: mutation.affected.has(target) });
  });
}

function policyDecision(candidate, { observedAffectedTarget, actualAffectedTarget, evidenceUnknown, risk, index, volatility }) {
  if (candidate === "memory") return { validate: false, safe: !actualAffectedTarget };
  if (candidate === "always") return { validate: true, safe: true };
  if (candidate === "smart") {
    const validate = evidenceUnknown || volatility >= 0.5 || isHighRisk(risk) || index % 5 === 0;
    return { validate, safe: validate || !actualAffectedTarget };
  }
  // PREMiSE uses the invalidation signal and validates affected or UNKNOWN actions.
  const validate = evidenceUnknown || observedAffectedTarget;
  return { validate, safe: validate || !actualAffectedTarget };
}

function runCandidate(candidate, options, cases) {
  const records = [];
  for (const scenario of cases) {
    const { graph, risk, mutation, affectedTarget, target, index } = scenario;
    const evidenceUnknown = mutation.evidence.status === "UNKNOWN";
    const observedChangedNodes = mutation.evidence.events.map((event) => event.nodeId);
    const observedAffectedTarget = candidate === "premise" && !evidenceUnknown
      ? affectedSet(graph, observedChangedNodes).has(target)
      : false;
    const decision = policyDecision(candidate, {
      observedAffectedTarget,
      actualAffectedTarget: affectedTarget,
      evidenceUnknown,
      risk,
      index,
      volatility: options.volatility
    });
    const record = emptyRecord();
    record.completed = 1;
    const minimum = minimumWork({ changedAffectsAction: mutation.changed && affectedTarget, actionRequiresFreshSource: mutation.changed && affectedTarget });
    record.minimumWork = minimum.external + minimum.validation + minimum.graph + minimum.protocol;
    record.eventSignals = mutation.evidence.signalCount;
    record.requests = 1 + (decision.validate ? 1 : 0);
    record.validations = decision.validate ? 1 : 0;
    record.sourceReads = decision.validate ? 1 : 0;
    record.reads = record.sourceReads;
    record.writes = 1;
    record.externalWork = record.sourceReads;
    record.protocolWork = 1;
    record.graphWork = candidate === "premise" && mutation.changed ? mutation.affected.size : 0;
    record.nodes = candidate === "premise" && mutation.changed ? mutation.affected.size : 1;
    record.edges = candidate === "premise" && mutation.changed ? Math.max(0, mutation.affected.size - 1) : 0;
    record.frontier = mutation.changed ? 1 : 0;
    record.dependencies = candidate === "premise" && mutation.changed ? mutation.affected.size : 0;
    record.invalidations = candidate === "premise" && mutation.changed ? mutation.affected.size : 0;
    record.reuse = decision.validate ? 0 : 1;
    record.batching = mutation.changed && candidate === "premise" ? 1 : 0;
    record.incrementality = candidate === "premise" && mutation.changed ? 1 : 0;
    record.mutatedAffected = affectedTarget ? 1 : 0;
    if (affectedTarget || evidenceUnknown) {
      record.staleDetections = decision.validate || candidate === "premise" ? 1 : 0;
      record.staleRecoveries = decision.safe && decision.validate ? 1 : 0;
    }
    if (!decision.safe) record.unsafeActions = 1;
    if (decision.safe) record.safeCompletions = 1;
    // v0 reports a declared logical latency model. Wall-clock timing is
    // machine-dependent and belongs to a later load campaign.
    record.latencyMs = Number((0.2 + record.requests * 0.2 + record.graphWork * 0.01 + record.protocolWork * 0.05).toFixed(6));
    Object.assign(record, createCounters(record));
    records.push(record);
  }
  return aggregateCandidateResults(records);
}

function reduction(candidate, baseline, field) {
  const left = candidatesValue(candidate, field);
  const right = candidatesValue(baseline, field);
  return typeof left === "number" && typeof right === "number" && right > 0 ? (1 - left / right) * 100 : null;
}

function candidatesValue(candidate, field) {
  return candidate?.[field];
}

export function runCampaign(options = {}) {
  const config = {
    tasks: options.tasks ?? DEFAULT_TASKS,
    seed: options.seed ?? DEFAULT_SEED,
    volatility: options.volatility ?? 0.25,
    nodeCount: options.nodeCount ?? 100,
    topologies: options.topologies ?? TOPOLOGIES
  };
  const cases = buildCases(config);
  const candidates = Object.fromEntries(CANDIDATES.map((candidate) => [candidate, runCandidate(candidate, config, cases)]));
  const blindInput = Object.entries(candidates).map(([id, result]) => ({
    id,
    unsafeActions: result.unsafeActions,
    toctouEscapes: result.toctouEscapes,
    crossTenantReuse: result.crossTenantReuse,
    workPerSafeCompletion: result.workPerSafeCompletion
  }));
  const blinded = anonymizeCandidates(blindInput, { seed: config.seed });
  const datasetFingerprint = cases.map((scenario) => ({
    index: scenario.index,
    topology: scenario.topology,
    graphHash: scenario.graph.metadata.hash,
    target: scenario.target,
    risk: scenario.risk,
    changedNodes: scenario.mutation.changedNodes
  }));
  const comparison = (baseline) => ({
    requestsReductionPct: reduction(candidates.premise, candidates[baseline], "requests"),
    readsReductionPct: reduction(candidates.premise, candidates[baseline], "sourceReads"),
    unsafeActionDelta: candidates.premise.unsafeActions - candidates[baseline].unsafeActions,
    safeCompletionDeltaPct: candidates.premise.safeCompletionRate - candidates[baseline].safeCompletionRate
  });
  return {
    format: "premise-efficiency-lab/0",
    campaign: "deterministic-calibration",
    config,
    candidates,
    comparisons: { vsAlways: comparison("always"), vsSmart: comparison("smart") },
    blindEvaluation: evaluateBlind(blinded.publicCandidates),
    blindMappingDigest: blinded.mappingDigest,
    sealedManifest: createSealedManifest(datasetFingerprint, { seed: config.seed }),
    safetyGate: {
      reference: "premise",
      premiseUnsafeActions: candidates.premise.unsafeActions,
      premiseSafeCompletionRate: candidates.premise.safeCompletionRate
    },
    claims: {
      status: "internal-calibration",
      externalConnectorEvidence: false,
      llmEvidence: false,
      blindReferee: true,
      commercialClaimReady: false
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = runCampaign(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
