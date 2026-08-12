import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compactManifestPath = resolve(root, "spec/premise-1/vectors/manifest.json");
const wireManifestPath = resolve(root, "spec/premise-1/test-vectors/manifest.json");
const evolutionManifests = [
  { profile: "premise/1.1", path: resolve(root, "spec/premise-1.1/vectors/manifest.json") },
  { profile: "premise-guard/1-rich", path: resolve(root, "spec/premise-guard-1/vectors/manifest.json") },
  { profile: "premise-policy/1", path: resolve(root, "spec/premise-policy-1/vectors/manifest.json") },
  { profile: "premise-policy/1-supplemental", path: resolve(root, "spec/premise-policy-1/vectors/supplemental-manifest.json") }
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }

function parseOutput(stdout, label) {
  try { return JSON.parse(stdout.trim()); }
  catch (error) { throw new Error(`${label} did not return JSON: ${error.message}\n${stdout}`); }
}

async function pythonCommand(args, label) {
  const candidates = process.env.PREMISE_PYTHON ? [process.env.PREMISE_PYTHON] : process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  let lastError;
  for (const candidate of candidates) {
    try {
      const actualArgs = candidate === "py" ? ["-3", ...args] : args;
      const { stdout } = await exec(candidate, actualArgs, { cwd: root, maxBuffer: 4 * 1024 * 1024 });
      return parseOutput(stdout, label);
    } catch (error) { lastError = error; }
  }
  throw new Error(`No usable Python interpreter found: ${lastError?.message ?? "unknown error"}`);
}

let typescriptBuilt = false;
async function buildReferenceTypescript() {
  if (typescriptBuilt) return;
  await exec(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "reference/typescript/tsconfig.json", "--pretty", "false"], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  typescriptBuilt = true;
}

async function runTypescript(manifestPath) {
  await buildReferenceTypescript();
  const { stdout } = await exec(process.execPath, ["reference/typescript/cli.mjs", manifestPath], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  return parseOutput(stdout, "TypeScript premise/1 reference");
}

async function runPythonCompact(manifestPath) {
  return pythonCommand(["reference/python/cli-premise1.py", manifestPath], "Python premise/1 reference");
}

async function runEvolutionTypescript(manifestPath) {
  await buildReferenceTypescript();
  const { stdout } = await exec(process.execPath, ["reference/typescript/dist/cli-evolution.js", manifestPath], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  return parseOutput(stdout, "TypeScript evolution reference");
}

async function runEvolutionPython(manifestPath) {
  return pythonCommand(["reference/python/cli-evolution.py", manifestPath], "Python evolution reference");
}

function assertEqual(left, right, label) {
  if (JSON.stringify(canonical(left)) !== JSON.stringify(canonical(right))) {
    throw new Error(`${label}\nleft: ${JSON.stringify(left)}\nright: ${JSON.stringify(right)}`);
  }
}

async function runCompact() {
  const manifest = await readJson(compactManifestPath);
  const vectors = await Promise.all(manifest.vectors.map((name) => readJson(resolve(dirname(compactManifestPath), name))));
  const [typescript, python] = await Promise.all([runTypescript(compactManifestPath), runPythonCompact(compactManifestPath)]);
  assertEqual(typescript, python, "Compact TypeScript/Python mismatch");
  const expectedById = new Map(vectors.map((vector) => [vector.id, vector.expected]));
  for (const row of typescript) {
    const vector = vectors.find((candidate) => candidate.id === row.id);
    const expected = vector?.operation === "revalidate" ? vector.results.map((item) => item.expected) : expectedById.get(row.id);
    assertEqual(row.output, expected, `Unexpected compact output for ${row.id}`);
  }
  if (typescript.length !== vectors.length) throw new Error(`Compact result count mismatch: ${typescript.length} != ${vectors.length}`);
  console.log(`PREMiSE/1 conformance: PASS (${vectors.length} vectors; TypeScript == Python == expected)`);
  for (const vector of vectors) console.log(`✓ ${vector.id}`);
}

function wireDecision(status) { return status === "FRESH" ? "USE" : status === "STALE" ? "REVALIDATE" : "REJECT"; }
function wireAggregate(states) {
  if (states.includes("INVALID")) return "INVALID";
  if (states.includes("UNKNOWN")) return "UNKNOWN";
  if (states.includes("STALE")) return "STALE";
  return "FRESH";
}
function wireState(memory) { return memory?.status ?? "UNKNOWN"; }
function wireSource(memory) {
  return Array.isArray(memory?.provenance) ? memory.provenance : [];
}
function wireRecompute(memories) {
  for (let round = 0; round <= memories.size; round += 1) {
    let changed = false;
    for (const memory of memories.values()) {
      const next = wireAggregate([memory.direct, ...memory.dependsOn.map((id) => wireState(memories.get(id)))]);
      if (next !== memory.status) { memory.status = next; changed = true; }
    }
    if (!changed) return;
  }
  throw new Error("DEPENDENCY_CYCLE");
}
function wireReachable(memories, root) {
  const affected = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, memory] of memories) if (!affected.has(id) && memory.dependsOn.some((dependency) => affected.has(dependency))) { affected.add(id); changed = true; }
  }
  return [...affected].sort();
}
function wireEnvelopeMemory(envelope) {
  return {
    direct: envelope.validity.status,
    status: envelope.validity.status,
    dependsOn: [...(envelope.dependsOn ?? [])],
    provenance: [...(envelope.evidence ?? [])]
  };
}
function wireExpectedEvents(type, memoryId, at) { return [{ type, memoryId, at }]; }
function wireExecuteVector(vector) {
  const memories = new Map();
  const initial = vector.initial && typeof vector.initial === "object" ? vector.initial : {};
  for (const item of Array.isArray(initial.memories) ? initial.memories : []) memories.set(item.memoryId, { direct: item.status, status: item.status, dependsOn: [...(item.dependsOn ?? [])], provenance: [...(item.provenance ?? [])] });
  wireRecompute(memories);
  const failures = [];
  for (const step of vector.steps ?? []) {
    const input = step.input ?? {};
    let actual = { accepted: true, events: [] };
    try {
      switch (step.operation) {
        case "register": {
          const envelope = input.envelope;
          const allowed = new Set(["specVersion", "tenantId", "memoryId", "contentDigest", "evidence", "validity", "dependsOn", "confidence", "conflicts", "temporal", "signatures"]);
          if (Object.keys(envelope).some((key) => !allowed.has(key))) throw new Error("UNKNOWN_FIELD");
          if (memories.has(envelope.memoryId)) throw new Error("MEMORY_EXISTS");
          memories.set(envelope.memoryId, wireEnvelopeMemory(envelope));
          wireRecompute(memories);
          const status = wireState(memories.get(envelope.memoryId));
          actual = { accepted: true, status, decision: wireDecision(status), events: wireExpectedEvents("MemoryRegistered", envelope.memoryId, envelope.validity.checkedAt) };
          break;
        }
        case "derive": {
          const envelope = input.envelope ?? input;
          const dependencies = [...(envelope.dependsOn ?? input.dependsOn ?? [])];
          if (dependencies.includes(envelope.memoryId) || dependencies.some((id) => !memories.has(id))) throw new Error("DEPENDENCY_CYCLE");
          memories.set(envelope.memoryId, wireEnvelopeMemory({ ...envelope, validity: envelope.validity ?? { status: "FRESH", checkedAt: initial.clock?.now }, evidence: envelope.evidence ?? [] }));
          wireRecompute(memories);
          actual = { accepted: true, status: wireState(memories.get(envelope.memoryId)), decision: wireDecision(wireState(memories.get(envelope.memoryId))), events: wireExpectedEvents("MemoryDerived", envelope.memoryId, envelope.validity?.checkedAt ?? initial.clock?.now) };
          break;
        }
        case "signal": {
          const root = input.memoryId;
          const affected = wireReachable(memories, root);
          for (const id of affected) { const memory = memories.get(id); if (memory && memory.direct !== "INVALID") memory.direct = "STALE"; }
          wireRecompute(memories);
          const status = wireState(memories.get(root));
          const events = input.sourceUri ? [
            { type: "SourceChanged", memoryId: root, at: initial.clock?.now },
            { type: "MemoryStaled", memoryId: root, at: initial.clock?.now }
          ] : [];
          actual = { accepted: true, status, decision: wireDecision(status), affected, states: Object.fromEntries(affected.map((id) => [id, wireState(memories.get(id))])), unrelated: Object.fromEntries([...memories.keys()].filter((id) => !affected.includes(id)).map((id) => [id, wireState(memories.get(id))])), events };
          break;
        }
        case "validate": {
          const ids = input.memoryIds ?? [input.memoryId];
          const results = input.results ?? { [input.memoryId]: input };
          for (const id of ids) {
            const memory = memories.get(id); const item = results[id] ?? {};
            let next = item.result === "UNCHANGED" ? "FRESH" : item.result === "UNKNOWN" ? "UNKNOWN" : "INVALID";
            if (memory?.direct === "INVALID" && next !== "INVALID") next = "INVALID";
            if (memory) memory.direct = next;
            wireRecompute(memories);
            const status = wireState(memory);
            actual = { accepted: true, status, decision: wireDecision(status), events: wireExpectedEvents("MemoryRevalidated", id, item.checkedAt) };
          }
          break;
        }
        case "replace": {
          const envelope = input.envelope;
          memories.set(envelope.memoryId, wireEnvelopeMemory(envelope));
          wireRecompute(memories);
          actual = { accepted: true, status: wireState(memories.get(envelope.memoryId)), decision: wireDecision(wireState(memories.get(envelope.memoryId))), events: wireExpectedEvents("MemoryReplaced", envelope.memoryId, envelope.validity.checkedAt) };
          break;
        }
        case "check": {
          const ids = input.memoryIds ?? [];
          actual = { results: ids.map((id) => ({ memoryId: id, status: wireState(memories.get(id)), decision: wireDecision(wireState(memories.get(id))) })), events: [], stateUnchanged: true };
          break;
        }
        case "capabilities": {
          if (input.specVersion !== "premise/1") throw new Error("UNSUPPORTED_SPEC_VERSION");
          const required = ["RECORD", "DEPENDENCY", "REVALIDATION", "TENANCY", "IDEMPOTENCY"];
          const missing = required.filter((capability) => !input.capabilities.includes(capability));
          actual = { compatible: missing.length === 0, missing, events: [] };
          break;
        }
        default: throw new Error(`UNSUPPORTED_OPERATION:${step.operation}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      actual = { accepted: false, ...(message === "UNSUPPORTED_SPEC_VERSION" ? { compatible: false } : {}), error: message, events: [], stateUnchanged: true, historyUnchanged: true };
    }
    if (!expectationMatches(actual, step.expect)) failures.push(`${vector.vectorId}/${step.id}: expectation did not match (${JSON.stringify(actual)})`);
  }
  return failures;
}
function expectationMatches(actual, expected) {
  if (expected === undefined) return true;
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => expectationMatches(actual[index], item));
  return actual && typeof actual === "object" && Object.entries(expected).every(([key, value]) => expectationMatches(actual[key], value));
}

function coreIdentity(entry) {
  return {
    tenantId: entry.tenantId,
    resourceId: entry.resourceId,
    incarnationId: entry.incarnationId,
    versionToken: entry.versionToken,
    observationId: entry.observationId
  };
}
function coreSame(left, right) {
  return left?.tenantId === right?.tenantId && left?.resourceId === right?.resourceId && left?.incarnationId === right?.incarnationId && left?.versionToken === right?.versionToken && left?.observationId === right?.observationId;
}
function coreStateView(state) { return [...state.values()].sort((left, right) => `${left.tenantId}:${left.resourceId}`.localeCompare(`${right.tenantId}:${right.resourceId}`)); }
function coreDependenciesHaveTenant(value, tenantId) {
  return (Array.isArray(value) ? value : []).every((item) => typeof item === "object" && item !== null && item.tenantId === tenantId);
}
function coreApplyStep(vector, state, ledger, step) {
  const input = step.input;
  const tenantId = input.tenantId;
  const changeSet = input.payload?.changeSet;
  const key = input.idempotencyKey;
  const previous = ledger.get(key);
  if (previous !== undefined) {
    if (previous.requestDigest === input.requestDigest) return { disposition: "REPLAY", receiptId: previous.receiptId, receiptSameAs: previous.firstStepId, stateUnchanged: true };
    return { disposition: "CONFLICT", reason: "IDEMPOTENCY_CONFLICT", stateUnchanged: true, receiptCreated: false, priorReceipt: previous.firstStepId };
  }
  if (changeSet.tenantId !== tenantId || changeSet.changes.some((change) => !coreDependenciesHaveTenant(change.dependsOn, tenantId)) || changeSet.causalSnapshot.entries.some((entry) => entry.tenantId !== tenantId)) {
    return { disposition: "REJECTED", reason: "TENANT_SCOPE", stateUnchanged: true, receiptCreated: false };
  }
  const nextState = new Map(state);
  for (const change of changeSet.changes) {
    const current = nextState.get(`${tenantId}:${change.resourceId}`);
    const snapshot = changeSet.causalSnapshot.entries.find((entry) => entry.resourceId === change.resourceId);
    if (current !== undefined && (snapshot === undefined || !coreSame(current, snapshot))) return { disposition: "REJECTED", reason: "ABA_MISMATCH", stateUnchanged: true, receiptCreated: false, state: coreStateView(state) };
    const after = { tenantId, resourceId: change.resourceId, ...change.after, dependsOn: change.dependsOn ?? [] };
    nextState.set(`${tenantId}:${change.resourceId}`, after);
  }
  state.clear();
  for (const [key, value] of nextState) state.set(key, value);
  const receiptId = `receipt:${input.operationId}`;
  const receipt = {
    kind: "receipt",
    specVersion: "premise/1.1",
    tenantId,
    receiptId,
    operationId: input.operationId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    requestDigest: input.requestDigest,
    changeSetId: changeSet.changeSetId,
    outcome: "APPLIED",
    coherence: "COHERENT",
    causalSnapshot: changeSet.causalSnapshot,
    frontier: []
  };
  ledger.set(key, { requestDigest: input.requestDigest, receiptId, receipt, firstStepId: step.id });
  return { disposition: "APPLIED", receiptId, receipt, state: coreStateView(state) };
}
function coreCheckStep(step) {
  const input = step.input;
  const set = input.payload?.premiseSet;
  const members = set?.members ?? [];
  const snapshot = set?.causalSnapshot?.entries ?? [];
  const requestedFrontier = input.payload?.requestedFrontier ?? set?.requestedFrontier;
  const frontierWasRequested = requestedFrontier !== undefined;
  if (members.some((member) => member.tenantId !== input.tenantId || !coreDependenciesHaveTenant(member.dependsOn, input.tenantId))) return { coherence: "INCOHERENT", decision: "REJECT", reason: "TENANT_SCOPE", frontier: [] };
  const mismatched = members.filter((member) => {
    const observed = snapshot.find((entry) => entry.resourceId === member.resourceId);
    return observed === undefined || !coreSame(member, observed);
  }).map(coreIdentity);
  if (mismatched.length === 0) return { coherence: "COHERENT", decision: "USE", frontier: [] };
  const canRevalidate = !frontierWasRequested || (Array.isArray(requestedFrontier) && requestedFrontier.length > 0);
  return { coherence: "INCOHERENT", decision: canRevalidate ? "REVALIDATE" : "REJECT", reason: canRevalidate ? "CAUSAL_MISMATCH" : "FRONTIER_INCOMPLETE", frontier: mismatched.filter((item, index, all) => all.findIndex((candidate) => coreSame(candidate, item)) === index) };
}
function coreRichExecute(vector) {
  const state = new Map();
  const ledger = new Map();
  const failures = [];
  for (const step of vector.steps ?? []) {
    let actual;
    if (step.operation === "apply") actual = coreApplyStep(vector, state, ledger, step);
    else if (step.operation === "check") actual = coreCheckStep(step);
    else actual = { disposition: "REJECTED", reason: "UNSUPPORTED_OPERATION", stateUnchanged: true };
    if (!expectationMatches(actual, step.expect)) failures.push(`${vector.vectorId}/${step.id}: expectation did not match (${JSON.stringify(actual)})`);
  }
  return failures;
}
async function runCoreRich() {
  const manifestPath = resolve(root, "spec/premise-1.1/test-vectors/manifest.json");
  const manifest = await readJson(manifestPath);
  const records = await Promise.all(manifest.files.map(async (entry) => readJson(resolve(dirname(manifestPath), entry.path))));
  const failures = records.flatMap(coreRichExecute);
  if (failures.length > 0) throw new Error(`premise/1.1 wire vectors failed:\n${failures.join("\n")}`);
  console.log(`PREMiSE/1.1 wire conformance: PASS (${records.length} vectors; executable state-machine reference)`);
  for (const vector of records) console.log(`✓ premise/1.1/wire/${vector.vectorId}`);
}

async function runWire() {
  const manifest = await readJson(wireManifestPath);
  const records = await Promise.all(manifest.vectors.map(async (entry) => ({
    entry,
    vector: await readJson(resolve(dirname(wireManifestPath), entry.file))
  })));
  const failures = records.flatMap(({ vector }) => wireExecuteVector(vector));
  if (failures.length > 0) throw new Error(`Wire vectors failed:\n${failures.join("\n")}`);
  console.log(`PREMiSE/1 wire conformance: PASS (${records.length} vectors; executable state-machine reference)`);
  for (const { entry } of records) console.log(`✓ wire/${entry.id}`);
}

async function runEvolution({ profile, path }) {
  const manifest = await readJson(path);
  const vectors = await Promise.all(manifest.vectors.map((entry) => readJson(resolve(dirname(path), typeof entry === "string" ? entry : entry.file))));
  const [typescript, python] = await Promise.all([runEvolutionTypescript(path), runEvolutionPython(path)]);
  assertEqual(typescript, python, `${profile} TypeScript/Python mismatch`);
  const expectedById = new Map(vectors.map((vector) => [vector.id, vector.expected]));
  for (const row of typescript) {
    const vector = vectors.find((candidate) => candidate.id === row.id || candidate.vectorId === row.id);
    if (profile === "premise-guard/1-rich") assertEqual(row.output, { steps: vector.steps.map((step) => ({ id: step.id, output: step.expect })) }, `Unexpected ${profile} output for ${row.id}`);
    else if (profile === "premise-policy/1-supplemental" && vector.operation === "guardedWrite") assertEqual(row.output, Object.fromEntries(vector.cases.map((item) => [item.id, item.expected])), `Unexpected ${profile} output for ${row.id}`);
    else assertEqual(row.output, expectedById.get(row.id), `Unexpected ${profile} output for ${row.id}`);
  }
  if (typescript.length !== vectors.length) throw new Error(`${profile} result count mismatch`);
  console.log(`PREMiSE ${profile} conformance: PASS (${vectors.length} vectors; TypeScript == Python == expected)`);
  for (const vector of vectors) console.log(`✓ ${profile}/${vector.id ?? vector.vectorId}`);
}

await runCompact();
await runWire();
await runCoreRich();
for (const manifest of evolutionManifests) await runEvolution(manifest);
