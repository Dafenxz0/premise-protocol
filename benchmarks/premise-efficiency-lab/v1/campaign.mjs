import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { anonymizeCandidates, compareReferenceResult, evaluateBlind } from "../referee/blind-evaluator.mjs";
import { createIndependentSmart } from "./baselines/independent-smart.mjs";
import { referenceForTask } from "./reference/scenario-reference.mjs";
import { runPhysicalTask } from "./runtime/runner.mjs";

export const CAMPAIGN_FORMAT = "premise-efficiency-lab/campaign/v1";
export const DEFAULT_SEED = 20260813;
export const DEFAULT_TASKS = 24;
export const CANDIDATES = Object.freeze(["memory", "independent-smart", "always", "premise"]);

const TOPOLOGIES = Object.freeze(["chain", "star", "diamond", "wide"]);
const RISK_LEVELS = Object.freeze(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const VERSION_SCHEME = "deterministic.source";
const PRIVATE_SCHEDULE_ENV = "PREMISE_EFFICIENCY_PRIVATE_SCHEDULE_KEY";
const DEVELOPMENT_SCHEDULE_KEY = "premise-efficiency-lab-v1-development-schedule";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function hash(value) {
  return `sha256:${createHash("sha256").update(stable(value), "utf8").digest("hex")}`;
}

async function readRepositoryCommit() {
  const explicit = process.env.GIT_COMMIT ?? process.env.GITHUB_SHA;
  if (explicit) return explicit;
  try {
    const gitEntryPath = resolve(process.cwd(), ".git");
    const gitEntry = await readFile(gitEntryPath, "utf8").catch(() => null);
    const gitDirectory = gitEntry?.startsWith("gitdir: ")
      ? resolve(dirname(gitEntryPath), gitEntry.slice("gitdir: ".length).trim())
      : gitEntryPath;
    const head = (await readFile(resolve(gitDirectory, "HEAD"), "utf8")).trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head;
    if (!head.startsWith("ref: ")) return head || null;
    const ref = head.slice("ref: ".length).trim();
    const direct = await readFile(resolve(gitDirectory, ref), "utf8").catch(() => null);
    if (direct?.trim()) return direct.trim();
    const packed = await readFile(resolve(gitDirectory, "packed-refs"), "utf8").catch(() => "");
    const packedLine = packed.split(/\r?\n/).find((line) => line.endsWith(` ${ref}`));
    return packedLine?.split(" ", 1)[0] ?? null;
  } catch {
    return null;
  }
}

async function digestRuntimeArtifact() {
  const artifactPath = process.env.PREMISE_RUNTIME_ARTIFACT
    ?? resolve(process.cwd(), "packages/runtime-core/dist/index.js");
  try {
    const artifact = await readFile(artifactPath);
    return {
      path: "packages/runtime-core/dist/index.js",
      digest: `sha256:${createHash("sha256").update(artifact).digest("hex")}`
    };
  } catch {
    return { path: "packages/runtime-core/dist/index.js", digest: null };
  }
}

function scheduleDigest(tasks) {
  return hash(tasks.map(({ publicTask, privateSpec }) => ({
    taskId: publicTask.taskId,
    affectsTarget: privateSpec.affectsTarget
  })));
}

async function collectProvenance({ seed, taskCount, schedule, safeCompletionFloor, tasks }) {
  const artifact = await digestRuntimeArtifact();
  const config = Object.freeze({
    format: CAMPAIGN_FORMAT,
    mode: "CALIBRATION_ONLY",
    physicalIsolation: "in-process-calibration",
    adapter: "DeterministicMutableSourceAdapter",
    store: "InMemoryRuntimeStore",
    seed,
    taskCount,
    topologies: TOPOLOGIES,
    riskLevels: RISK_LEVELS,
    versionScheme: VERSION_SCHEME,
    safeCompletionFloor
  });
  return Object.freeze({
    commit: await readRepositoryCommit(),
    artifactPath: artifact.path,
    artifactDigest: artifact.digest,
    privateScheduleMode: schedule.mode,
    privateScheduleDigest: scheduleDigest(tasks),
    config
  });
}

function resolvePrivateScheduleKey(value) {
  const supplied = value ?? process.env[PRIVATE_SCHEDULE_ENV];
  return {
    key: String(supplied ?? DEVELOPMENT_SCHEDULE_KEY),
    mode: supplied === undefined ? "development-default" : "provided-secret"
  };
}

function privateAffectsTarget(seed, index, privateScheduleKey) {
  const digest = createHmac("sha256", privateScheduleKey)
    .update(`${CAMPAIGN_FORMAT}:affects-target:${seed}:${index}`, "utf8")
    .digest();
  return (digest[0] & 1) === 1;
}

function randomVersion(seed, index, token) {
  return { scheme: VERSION_SCHEME, token: `${token}-${hash({ seed, index, token }).slice(-8)}` };
}

function topologyNodes(index, topology, targetSource, noiseSource) {
  const root = { id: "memory:target", sourceUri: targetSource, version: { scheme: VERSION_SCHEME, token: "a" }, content: { value: index } };
  const noise = { id: "memory:noise", sourceUri: noiseSource, version: { scheme: VERSION_SCHEME, token: "a" }, content: { value: "noise" } };
  if (topology === "star") {
    return [root, noise, ...Array.from({ length: 8 }, (_, child) => ({ id: `memory:star-${child}`, dependsOn: [root.id] }))];
  }
  if (topology === "diamond") {
    return [root, noise,
      { id: "memory:left", dependsOn: [root.id] },
      { id: "memory:right", dependsOn: [root.id] },
      { id: "memory:join", dependsOn: ["memory:left", "memory:right"] }];
  }
  if (topology === "wide") {
    return [root, noise, ...Array.from({ length: 4 }, (_, child) => ({ id: `memory:wide-${child}`, dependsOn: [root.id] })),
      { id: "memory:wide-join", dependsOn: ["memory:wide-0", "memory:wide-1", "memory:wide-2", "memory:wide-3"] }];
  }
  return [root, noise,
    { id: "memory:chain-1", dependsOn: [root.id] },
    { id: "memory:chain-2", dependsOn: ["memory:chain-1"] },
    { id: "memory:chain-3", dependsOn: ["memory:chain-2"] }];
}

function makeTask(seed, index, privateScheduleKey) {
  const topology = TOPOLOGIES[index % TOPOLOGIES.length];
  const risk = RISK_LEVELS[index % RISK_LEVELS.length];
  const targetSource = `source://efficiency-lab/${seed}/${index}/target`;
  const noiseSource = `source://efficiency-lab/${seed}/${index}/noise`;
  const affectsTarget = privateAffectsTarget(seed, index, privateScheduleKey);
  const deliverEvents = index % 7 !== 0;
  const initialTargetVersion = { scheme: VERSION_SCHEME, token: "a" };
  const mutation = {
    sourceUri: affectsTarget ? targetSource : noiseSource,
    token: randomVersion(seed, index, "b").token,
    value: { revision: 2, taskClass: affectsTarget ? "target" : "noise" }
  };
  const nodes = topologyNodes(index, topology, targetSource, noiseSource);
  const publicTask = Object.freeze({
    taskId: `task-${hash({ seed, index }).slice(-16)}`,
    topology,
    risk,
    targetId: "memory:target",
    observedVersion: initialTargetVersion,
    action: { kind: "conditional-update", taskClass: "efficiency-lab" },
    eventDelivered: deliverEvents,
    graph: Object.freeze(nodes.map(({ id, dependsOn }) => Object.freeze({ id, ...(dependsOn ? { dependsOn } : {}) })))
  });
  const privateSpec = Object.freeze({
    taskId: publicTask.taskId,
    now: `2026-08-13T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
    nodes,
    targetIds: ["memory:target"],
    sources: {
      [targetSource]: { version: initialTargetVersion, value: { value: index } },
      [noiseSource]: { version: { scheme: VERSION_SCHEME, token: "a" }, value: { value: "noise" } }
    },
    mutation,
    deliverEvents,
    performAction: true,
    action: publicTask.action,
    initialTargetVersion,
    affectsTarget,
    topology,
    risk
  });
  return Object.freeze({ publicTask, privateSpec });
}

export function buildCampaignTasks({ seed = DEFAULT_SEED, tasks = DEFAULT_TASKS, privateScheduleKey } = {}) {
  if (!Number.isSafeInteger(tasks) || tasks < 1 || tasks > 10_000) throw new RangeError("tasks must be an integer in [1, 10000]");
  const { key } = resolvePrivateScheduleKey(privateScheduleKey);
  return Object.freeze(Array.from({ length: tasks }, (_, index) => makeTask(seed, index, key)));
}

class MutableWorld {
  constructor(spec) {
    this.state = new Map(Object.entries(spec.sources).map(([sourceUri, source]) => [sourceUri, {
      sourceUri,
      version: clone(source.version),
      value: clone(source.value)
    }]));
    this.reads = 0;
    this.writes = 0;
    this.casConflicts = 0;
    this.mutation = null;
  }

  mutate(input) {
    const state = this.state.get(input.sourceUri);
    state.version = { scheme: VERSION_SCHEME, token: input.token };
    state.value = clone(input.value);
    this.mutation = input.sourceUri;
  }

  read(sourceUri) {
    this.reads += 1;
    const state = this.state.get(sourceUri);
    return clone(state);
  }

  actIfVersion(sourceUri, expectedVersion, action) {
    this.writes += 1;
    const state = this.state.get(sourceUri);
    if (state === undefined || state.version.token !== expectedVersion) {
      this.casConflicts += 1;
      return { accepted: false, reason: "VERSION_MISMATCH", observedVersion: state?.version.token };
    }
    return { accepted: true, result: clone(action) };
  }

  actUnchecked(action) {
    this.writes += 1;
    return { accepted: true, result: clone(action) };
  }
}

function baseCounters() {
  return { sourceReads: 0, recordReads: 0, recordBatchReads: 0, eventContinuityChecks: 0, CASAttempts: 0, CASConflicts: 0, CASSuccesses: 0, writeIntents: 0, nodesVisited: 0, edgesTraversed: 0, frontierNodesVisited: 0, frontierRecomputes: 0, cacheHits: 0, cacheMisses: 0, decisions: 0, totalWork: 0 };
}

function addCounters(left, right) {
  for (const [key, value] of Object.entries(right ?? {})) {
    if (typeof value !== "number") continue;
    if (typeof left[key] !== "number") left[key] = 0;
    left[key] += value;
  }
  return left;
}

function recordFromTrace(candidate, task, trace, extra = {}) {
  const counters = { ...baseCounters(), ...(trace?.counters ?? {}), ...(extra.counters ?? {}) };
  const workBreakdown = trace?.workBreakdown ?? extra.workBreakdown;
  const action = trace?.action ?? extra.action;
  const accepted = Boolean(action?.accepted);
  const detectedAffected = Boolean(
    extra.detectedAffected ||
    action?.reason === "VERSION_MISMATCH" ||
    trace?.decisions?.some((event) => event.memoryId === task.publicTask.targetId && ["REVALIDATE", "REJECT"].includes(event.decision))
  );
  counters.totalWork = workBreakdown?.total ?? counters.sourceReads + counters.recordReads + counters.CASAttempts + counters.eventContinuityChecks
    + counters.nodesVisited + counters.edgesTraversed + Math.max(counters.CASAttempts, counters.writeIntents);
  return {
    candidate,
    taskId: task.publicTask.taskId,
    accepted,
    detectedAffected,
    counters,
    workBreakdown: workBreakdown === undefined ? undefined : {
      query: workBreakdown.query,
      maintenance: workBreakdown.maintenance,
      total: workBreakdown.total
    },
    normative: trace?.normative ?? extra.normative,
    safeCompletion: 0,
    unsafe: 0,
    falseBlock: 0,
    toctou: 0,
    validated: Boolean(extra.validated)
  };
}

async function runPremiseTask(task) {
  const trace = await runPhysicalTask({ ...task.privateSpec, candidateId: "blind-candidate", commit: "runtime-core", includeNormative: true });
  return recordFromTrace("premise", task, trace);
}

async function runAlwaysTask(task) {
  const world = new MutableWorld(task.privateSpec);
  world.mutate(task.privateSpec.mutation);
  const targetSource = Object.keys(task.privateSpec.sources)[0];
  const target = world.read(targetSource);
  const action = world.actIfVersion(targetSource, target.version.token, task.publicTask.action);
  return recordFromTrace("always", task, null, {
    action,
    detectedAffected: !sameToken(target.version.token, task.privateSpec.initialTargetVersion.token),
    validated: true,
    counters: { sourceReads: world.reads, CASAttempts: world.writes, CASConflicts: world.casConflicts, CASSuccesses: action.accepted ? 1 : 0, writeIntents: world.writes }
  });
}

function sameToken(left, right) {
  return left === right;
}

async function runMemoryTask(task) {
  const world = new MutableWorld(task.privateSpec);
  world.mutate(task.privateSpec.mutation);
  const action = world.actUnchecked(task.publicTask.action);
  return recordFromTrace("memory", task, null, {
    action,
    counters: { CASAttempts: 0, writeIntents: world.writes }
  });
}

async function runIndependentSmartTask(task, baseline) {
  const world = new MutableWorld(task.privateSpec);
  world.mutate(task.privateSpec.mutation);
  const targetSource = Object.keys(task.privateSpec.sources)[0];
  const result = await baseline.execute({
    tenantId: "tenant:efficiency-lab",
    resourceId: targetSource,
    scopeDigest: "target",
    queryDigest: "action",
    observedVersion: task.privateSpec.initialTargetVersion,
    logicalTime: Number(task.publicTask.taskId.slice(-4), 16) || 0,
    risk: task.privateSpec.risk,
    action: task.publicTask.action,
    events: task.privateSpec.deliverEvents && task.privateSpec.affectsTarget
      ? [{ resourceId: targetSource, version: { scheme: VERSION_SCHEME, token: task.privateSpec.mutation.token } }]
      : []
  }, {
    async read() { return world.read(targetSource); },
    async actIfVersion(expectedVersion, action) { return world.actIfVersion(targetSource, expectedVersion.token ?? expectedVersion, action); }
  });
  return recordFromTrace("independent-smart", task, null, {
    action: { accepted: result.accepted, reason: result.accepted ? undefined : "VERSION_MISMATCH" },
    detectedAffected: result.trace.decisions.some((decision) => decision !== "CACHE_REUSE"),
    validated: result.trace.reads > 0,
    counters: {
      sourceReads: world.reads,
      CASAttempts: world.writes,
      CASConflicts: world.casConflicts,
      CASSuccesses: result.accepted ? 1 : 0,
      writeIntents: world.writes
    }
  });
}

function classify(candidate, records, tasks) {
  const byId = new Map(tasks.map((task) => [task.publicTask.taskId, task]));
  const aggregate = {
    completed: records.length,
    safeCompletions: 0,
    unsafeActions: 0,
    falseBlocks: 0,
    toctouEscapes: 0,
    affectedRecallHits: 0,
    ...baseCounters()
  };
  const referenceChecks = [];
  for (const record of records) {
    const task = byId.get(record.taskId);
    const affected = task.privateSpec.affectsTarget;
    const unsafe = record.accepted && affected && !record.detectedAffected;
    const falseBlock = !record.accepted && !affected;
    record.unsafe = unsafe ? 1 : 0;
    record.falseBlock = falseBlock ? 1 : 0;
    record.toctou = unsafe && !task.privateSpec.deliverEvents ? 1 : 0;
    record.safeCompletion = record.accepted && !unsafe ? 1 : 0;
    const reference = referenceForTask(task.privateSpec);
    record.referenceEquivalence = compareReferenceResult(reference, record.normative);
    referenceChecks.push(record.referenceEquivalence);
    aggregate.safeCompletions += record.safeCompletion;
    aggregate.unsafeActions += record.unsafe;
    aggregate.falseBlocks += record.falseBlock;
    aggregate.toctouEscapes += record.toctou;
    aggregate.affectedRecallHits += affected && record.detectedAffected ? 1 : 0;
    addCounters(aggregate, record.counters);
    aggregate.queryWork = (aggregate.queryWork ?? 0) + (record.workBreakdown?.query ?? record.counters.totalWork);
    aggregate.maintenanceWork = (aggregate.maintenanceWork ?? 0) + (record.workBreakdown?.maintenance ?? 0);
  }
  aggregate.affectedRecall = tasks.filter((task) => task.privateSpec.affectsTarget).length === 0
    ? 1
    : aggregate.affectedRecallHits / tasks.filter((task) => task.privateSpec.affectsTarget).length;
  aggregate.safeCompletion = aggregate.safeCompletions;
  aggregate.safeCompletionRate = aggregate.completed === 0 ? null : aggregate.safeCompletions / aggregate.completed;
  const referenceStatus = referenceChecks.length === 0 ? "UNKNOWN"
    : referenceChecks.some((check) => check.status === "FAIL") ? "FAIL"
      : referenceChecks.some((check) => check.status === "UNKNOWN") ? "UNKNOWN" : "PASS";
  aggregate.referenceEquivalent = candidate === "premise" ? referenceStatus : "UNKNOWN";
  aggregate.referenceEquivalence = {
    status: aggregate.referenceEquivalent,
    decision: referenceChecks.every((check) => check.fields.decision === "PASS") ? "PASS" : referenceChecks.some((check) => check.fields.decision === "FAIL") ? "FAIL" : "UNKNOWN",
    coherence: referenceChecks.every((check) => check.fields.coherence === "PASS") ? "PASS" : referenceChecks.some((check) => check.fields.coherence === "FAIL") ? "FAIL" : "UNKNOWN",
    frontier: referenceChecks.every((check) => check.fields.frontier === "PASS") ? "PASS" : referenceChecks.some((check) => check.fields.frontier === "FAIL") ? "FAIL" : "UNKNOWN",
    guard: referenceChecks.every((check) => check.fields.guard === "PASS") ? "PASS" : referenceChecks.some((check) => check.fields.guard === "FAIL") ? "FAIL" : "UNKNOWN",
    actionOutcome: referenceChecks.every((check) => check.fields.actionOutcome === "PASS") ? "PASS" : referenceChecks.some((check) => check.fields.actionOutcome === "FAIL") ? "FAIL" : "UNKNOWN"
  };
  // These dimensions are deliberately not inferred from this calibration
  // workload. An absent experiment is UNKNOWN, never a fabricated zero.
  aggregate.staleReceiptReuse = "UNKNOWN";
  aggregate.crossTenantReuse = "UNKNOWN";
  aggregate.unknownPromotedFresh = "UNKNOWN";
  aggregate.invalidReceiptAccepted = "UNKNOWN";
  aggregate.authorizationScopeViolations = "UNKNOWN";
  aggregate.incarnationViolations = "UNKNOWN";
  aggregate.replayViolations = "UNKNOWN";
  aggregate.queryWork = aggregate.queryWork ?? 0;
  aggregate.maintenanceWork = aggregate.maintenanceWork ?? 0;
  aggregate.totalWork = aggregate.queryWork + aggregate.maintenanceWork;
  aggregate.workPerSafeCompletion = aggregate.safeCompletions > 0 ? aggregate.totalWork / aggregate.safeCompletions : null;
  // No legal-plan denominator is executed by the in-process calibration.
  // Keep the three amplification metrics explicit but UNKNOWN.
  aggregate.WA_query = "UNKNOWN";
  aggregate.WA_maintenance = "UNKNOWN";
  aggregate.WA_total = "UNKNOWN";
  aggregate.WA_external = "UNKNOWN";
  aggregate.WA_graph = "UNKNOWN";
  aggregate.WA_validate = "UNKNOWN";
  aggregate.WA_write = "UNKNOWN";
  aggregate.physicalOperations = aggregate.totalWork;
  aggregate.latency = "UNKNOWN";
  aggregate.work = {
    graph: aggregate.nodesVisited + aggregate.edgesTraversed,
    external: aggregate.sourceReads + Math.max(aggregate.CASAttempts, aggregate.writeIntents),
    validation: aggregate.sourceReads,
    write: Math.max(aggregate.CASAttempts, aggregate.writeIntents)
  };
  return aggregate;
}

function examineCandidate(candidate, records, tasks) {
  return classify(candidate, records, tasks);
}

function table(examined) {
  const rows = Object.entries(examined).map(([id, result]) => `| ${id} | ${result.safeCompletionRate === null ? "UNKNOWN" : `${(result.safeCompletionRate * 100).toFixed(1)}%`} | ${result.unsafeActions} | ${result.falseBlocks} | ${result.sourceReads} | ${result.CASAttempts} | ${result.queryWork} | ${result.maintenanceWork} | ${result.workPerSafeCompletion === null ? "UNKNOWN" : result.workPerSafeCompletion.toFixed(2)} |`);
  return [
    "| Candidate | Safe completions | Unsafe actions | False blocks | Source reads | CAS attempts | Query work | Maintenance work | Work / safe completion |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows
  ].join("\n");
}

export async function runEfficiencyCampaign(options = {}) {
  const seed = options.seed ?? DEFAULT_SEED;
  const safeCompletionFloor = options.safeCompletionFloor ?? 1;
  if (!Number.isSafeInteger(safeCompletionFloor) || safeCompletionFloor < 1) {
    throw new RangeError("safeCompletionFloor must be a positive safe integer");
  }
  const schedule = resolvePrivateScheduleKey(options.privateScheduleKey);
  const tasks = buildCampaignTasks({ seed, tasks: options.tasks ?? DEFAULT_TASKS, privateScheduleKey: schedule.key });
  const records = Object.fromEntries(CANDIDATES.map((candidate) => [candidate, []]));
  const smart = createIndependentSmart({ baseTtl: 4, minTtl: 1, maxTtl: 16 });
  for (const task of tasks) {
    records.premise.push(await runPremiseTask(task));
    records.always.push(await runAlwaysTask(task));
    records.memory.push(await runMemoryTask(task));
    records["independent-smart"].push(await runIndependentSmartTask(task, smart));
  }
  const examined = Object.fromEntries(CANDIDATES.map((candidate) => [candidate, examineCandidate(candidate, records[candidate], tasks)]));
  const blindInput = CANDIDATES.map((candidate) => ({ id: candidate, ...examined[candidate] }));
  const blinded = anonymizeCandidates(blindInput, { seed: `v1:${seed}` });
  const blindEvaluation = evaluateBlind(blinded.publicCandidates, {
    enforceSafetyGates: true,
    rankingMode: "v1",
    referenceFalseBlockCeiling: 0,
    referenceSafeCompletionFloor: safeCompletionFloor
  });
  // This calibration does not yet derive a legal-plan lower bound per task.
  // Never turn a campaign-wide estimate into a Work Amplification claim.
  const oracleCertificate = Object.freeze({
    mode: "UNKNOWN",
    reason: "per-task legal-plan enumeration is not part of the in-process calibration"
  });
  const amplifications = Object.fromEntries(CANDIDATES.map((candidate) => [candidate, {
    mode: oracleCertificate.mode,
    reason: oracleCertificate.reason,
    candidate
  }]));
  const provenance = await collectProvenance({ seed, taskCount: tasks.length, schedule, safeCompletionFloor, tasks });
  const calibrationBlind = Object.freeze({
    ...blindEvaluation,
    status: "INCONCLUSIVE",
    reason: "CALIBRATION_ONLY: in-process candidate/oracle isolation is not certified",
    campaignMode: "CALIBRATION_ONLY",
    rankingSuppressed: true,
    scientificRanking: null,
    eligibleCount: 0,
    ranking: Object.freeze([])
  });
  return Object.freeze({
    format: CAMPAIGN_FORMAT,
    status: "INCONCLUSIVE",
    campaignMode: "CALIBRATION_ONLY",
    physicalIsolation: "in-process-calibration",
    seed,
    taskCount: tasks.length,
    commit: provenance.commit,
    artifactDigest: provenance.artifactDigest,
    config: provenance.config,
    provenance,
    publicTasks: tasks.map(({ publicTask }) => publicTask),
    blind: { ...calibrationBlind, mappingDigest: blinded.mappingDigest, publicCandidates: blinded.publicCandidates },
    examined,
    amplifications,
    oracleCertificate,
    traces: records,
    claims: {
      runtimeCandidateIsPhysical: true,
      candidateOraclePhysicalIsolation: false,
      scientificRanking: false,
      commercialEfficiencyClaim: false,
      holdoutIndependent: false
    },
    table: table(examined)
  });
}

async function writeCampaign(result, output) {
  const root = resolve(output);
  await mkdir(root, { recursive: true });
  const publicTasks = result.publicTasks;
  const blind = { ...result.blind, publicCandidates: result.blind.publicCandidates };
  await writeFile(resolve(root, "public-tasks.json"), `${JSON.stringify(publicTasks, null, 2)}\n`);
  await writeFile(resolve(root, "blind-report.json"), `${JSON.stringify(blind, null, 2)}\n`);
  await writeFile(resolve(root, "examined-report.json"), `${JSON.stringify(result.examined, null, 2)}\n`);
  await writeFile(resolve(root, "oracle-certificate.json"), `${JSON.stringify({ ...result.oracleCertificate, taskCount: result.taskCount, amplifications: result.amplifications, provenance: result.provenance }, null, 2)}\n`);
  await writeFile(resolve(root, "operation-traces.json"), `${JSON.stringify(result.traces, null, 2)}\n`);
  await writeFile(resolve(root, "tables.md"), `${result.table}\n`);
  await writeFile(resolve(root, "report.md"), `# PREMiSE Efficiency Lab v1 campaign\n\nStatus: **${result.status}**\n\nMode: **${result.campaignMode}**\n\nThis is a physical runtime calibration, not a scientific ranking or commercial claim. Candidate/oracle process isolation is not certified in this report, so the diagnostic ordering is suppressed.\n\n${result.table}\n`);
  await writeFile(resolve(root, "claims.json"), `${JSON.stringify(result.claims, null, 2)}\n`);
  await writeFile(resolve(root, "manifest.json"), `${JSON.stringify({
    format: CAMPAIGN_FORMAT,
    status: result.status,
    campaignMode: result.campaignMode,
    seed: result.seed,
    taskCount: result.taskCount,
    publicTaskHash: hash(publicTasks),
    blindReportHash: hash(blind),
    provenance: result.provenance
  }, null, 2)}\n`);
  return root;
}

export { writeCampaign };

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const args = Object.fromEntries(process.argv.slice(2).map((value) => {
    const [key, raw] = value.replace(/^--/, "").split("=");
    return [key, raw === undefined ? true : (/^\d+$/.test(raw) ? Number(raw) : raw)];
  }));
  const result = await runEfficiencyCampaign({ seed: args.seed ?? DEFAULT_SEED, tasks: args.tasks ?? DEFAULT_TASKS });
  const output = args.output ?? `.tmp/premise-efficiency-lab/v1/campaign-${result.seed}`;
  await writeCampaign(result, output);
  process.stdout.write(`${JSON.stringify({ status: result.status, output, blind: result.blind }, null, 2)}\n`);
}
