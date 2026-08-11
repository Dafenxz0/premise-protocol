import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mutationArmOrder, mutationStrategies } from "./mutation-strategies.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const outputRoot = resolve(root, "benchmarks/premisebench-agent/artifacts/mutation-campaign");
const pricing = Object.freeze({
  id: "synthetic-token-proxy-v1",
  inputUsdPerMillion: 0.15,
  outputUsdPerMillion: 0.60,
  status: "proxy-not-provider-billing",
  scope: "payload-volume-comparison-only",
  billable: false
});

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.find((value) => value.startsWith(prefix));
  return item === undefined ? fallback : item.slice(prefix.length);
}

function stable(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function sha(value) {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : stable(value), "utf8").digest("hex")}`;
}

function tokenProxy(value) {
  return Math.max(1, Math.ceil(Buffer.byteLength(stable(value), "utf8") / 4));
}

function moneyProxy(inputTokens, outputTokens) {
  return (inputTokens * pricing.inputUsdPerMillion + outputTokens * pricing.outputUsdPerMillion) / 1_000_000;
}

function familyFor(index, seed) {
  const slot = (index + Math.abs(seed)) % 10;
  if (slot < 5) return "stable";
  if (slot < 7) return "repairable";
  if (slot < 9) return "incompatible";
  return "toctou";
}

function makeTask(index, seed) {
  const family = familyFor(index, seed);
  const value = `safe-${seed}-${index}`;
  const initial = { status: "active", value, revision: "v1" };
  const mutation = family === "repairable"
    ? { status: "active", value: `${value}-updated`, revision: "v2" }
    : family === "incompatible"
      ? { status: "blocked", value: "do-not-apply", revision: "v2" }
      : { ...initial, revision: family === "toctou" ? "v2" : "v1" };
  return {
    taskId: `mutation-${seed}-${String(index + 1).padStart(4, "0")}`,
    prompt: "Decide si es seguro aplicar la observación actual de config.json.",
    source: "filesystem:config.json",
    family,
    initial,
    mutation,
    mutationWindow: family === "stable" ? "none" : family === "toctou" ? "during-write" : "before-action"
  };
}

function makeTasks(count, seed) {
  return Array.from({ length: count }, (_, index) => makeTask(index, seed));
}

function snapshot(content) {
  return { content: structuredClone(content), version: sha(content) };
}

function completeBasedOnVersion(expectedVersion, action) {
  return { ...action, basedOnVersion: expectedVersion };
}

function compactCasAction(expectedVersion, action) {
  if (action?.basedOnVersion !== undefined && action.basedOnVersion !== expectedVersion) {
    throw new Error("actIfVersion action version must match expectedVersion");
  }
  const { basedOnVersion: _basedOnVersion, ...compactAction } = action;
  return compactAction;
}

function createWorld(task) {
  let current = structuredClone(task.initial);
  let mutated = false;
  let lastAction = null;
  let mutationEvent = null;

  function mutate() {
    if (mutated || task.mutationWindow === "none") return mutationEvent;
    current = structuredClone(task.mutation);
    mutated = true;
    mutationEvent = { source: task.source, version: sha(current), kind: "INVALIDATE" };
    return mutationEvent;
  }

  return {
    initial: snapshot(current),
    mutate,
    get mutationEvent() { return mutationEvent; },
    read() { return snapshot(current); },
    act(action) {
      if (task.mutationWindow === "during-write") mutate();
      lastAction = { ...action, accepted: true };
      return { accepted: true };
    },
    actIfVersion(expectedVersion, action) {
      if (task.mutationWindow === "during-write") mutate();
      const currentVersion = sha(current);
      if (currentVersion !== expectedVersion) return { accepted: false, reason: "VERSION_MISMATCH", currentVersion };
      lastAction = { ...completeBasedOnVersion(expectedVersion, action), accepted: true };
      return { accepted: true };
    },
    evaluate() {
      const currentSnapshot = snapshot(current);
      const correct = current.status === "blocked"
        ? lastAction === null || lastAction.kind === "reject"
        : lastAction?.kind === "apply" && lastAction.value === current.value && lastAction.basedOnVersion === currentSnapshot.version;
      const falseBlock = current.status !== "blocked" && (lastAction === null || lastAction.kind === "reject");
      const unsafe = lastAction?.kind === "apply" && (!correct || current.status === "blocked");
      return {
        current: currentSnapshot,
        action: lastAction,
        correct,
        falseBlock,
        unsafe,
        changed: mutated,
        recovered: mutated && correct,
        toctouEscape: task.family === "toctou" && Boolean(unsafe),
        mutationCount: mutated ? 1 : 0
      };
    }
  };
}

function summarizeTokens(input, output, operations) {
  return {
    input,
    output,
    total: input + output,
    costUsd: moneyProxy(input, output),
    operations
  };
}

function createTelemetry(agentInput) {
  const operations = [];
  const buckets = {
    protocolPayload: { input: 0, output: 0, operations: 0 },
    externalOperation: { input: 0, output: 0, operations: 0 }
  };
  const agentInputTokens = tokenProxy(agentInput);

  function record(bucketName, kind, input, output) {
    const bucket = buckets[bucketName];
    if (bucket === undefined) throw new Error(`Unknown telemetry bucket: ${bucketName}`);
    const inputTokens = tokenProxy(input);
    const outputTokens = tokenProxy(output);
    bucket.input += inputTokens;
    bucket.output += outputTokens;
    bucket.operations += 1;
    operations.push({
      kind,
      category: bucketName,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens
    });
  }

  function summary() {
    const protocolPayload = summarizeTokens(
      buckets.protocolPayload.input,
      buckets.protocolPayload.output,
      buckets.protocolPayload.operations
    );
    const externalOperations = summarizeTokens(
      buckets.externalOperation.input,
      buckets.externalOperation.output,
      buckets.externalOperation.operations
    );
    const initialAgentInput = summarizeTokens(agentInputTokens, 0, 1);
    const agentVisible = summarizeTokens(
      initialAgentInput.input + externalOperations.input,
      initialAgentInput.output + externalOperations.output,
      initialAgentInput.operations + externalOperations.operations
    );
    const input = initialAgentInput.input + protocolPayload.input + externalOperations.input;
    const output = initialAgentInput.output + protocolPayload.output + externalOperations.output;
    return {
      initialAgentInput,
      agentInputTokensProxy: initialAgentInput.total,
      agentVisibleTokenProxy: agentVisible.total,
      agentVisibleCostProxy: agentVisible.costUsd,
      protocolPayload,
      // Local checks and other internal protocol work are runtime payload,
      // not model/provider usage.
      runtimePayload: protocolPayload,
      runtimePayloadTokens: protocolPayload.total,
      runtimePayloadCostProxy: protocolPayload.costUsd,
      runtimeOperations: protocolPayload.operations,
      runtimePayloadBillable: false,
      externalOperations,
      input,
      output,
      total: input + output,
      costUsd: moneyProxy(input, output),
      pricing,
      accounting: "initial input once; runtime payload measured separately; one request/response pair per external operation",
      providerUsage: {
        status: "UNKNOWN",
        tokens: null,
        costUsd: null
      }
    };
  }

  return {
    recordProtocol(kind, input, output) { record("protocolPayload", kind, input, output); },
    recordExternal(kind, input, output) { record("externalOperation", kind, input, output); },
    summary,
    get operations() { return operations; }
  };
}

function createContext(task, world, memory, agentInput) {
  const telemetry = createTelemetry(agentInput);
  let externalReads = 0;
  let externalWrites = 0;
  let localChecks = 0;
  let invalidationEvents = 0;
  // The initial memory is already counted in agentInput. Keep only a reference
  // here so the same evidence payload is not charged twice.
  telemetry.recordProtocol("memory-lookup", { taskId: task.taskId, source: task.source }, { source: task.source, version: memory.version });
  if (world.mutationEvent !== null) invalidationEvents += 1;

  const context = {
    task: { taskId: task.taskId, source: task.source },
    memory,
    checkEvidence() {
      localChecks += 1;
      const event = world.mutationEvent;
      const state = event === null || event.version === memory.version ? "FRESH" : "STALE";
      telemetry.recordProtocol("local-check", { observedVersion: memory.version }, { state });
      return { state };
    },
    async sourceRead(reason) {
      externalReads += 1;
      const result = world.read();
      telemetry.recordExternal("source-read", { source: task.source, reason }, result);
      return result;
    },
    act(action) {
      externalWrites += 1;
      const response = world.act(action);
      telemetry.recordExternal("write", action, response);
      return response;
    },
    actIfVersion(expectedVersion, action) {
      externalWrites += 1;
      const compactAction = compactCasAction(expectedVersion, action);
      const response = world.actIfVersion(expectedVersion, compactAction);
      telemetry.recordExternal("compare-and-set", { expectedVersion, action: compactAction }, response);
      return response;
    },
    reject(action) {
      externalWrites += 1;
      const response = world.act(action);
      telemetry.recordExternal("reject", action, response);
      return response;
    }
  };
  return {
    context,
    telemetry,
    counters() {
      const tokenProxy = telemetry.summary();
      return {
        externalReads,
        externalWrites,
        connectorRequests: externalReads + externalWrites,
        localChecks,
        invalidationEvents,
        operations: telemetry.operations,
        tokenProxy,
        runtimePayloadTokens: tokenProxy.runtimePayloadTokens,
        runtimeOperations: tokenProxy.runtimeOperations
      };
    }
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
}

async function runArm(arm, task) {
  const world = createWorld(task);
  const initial = world.initial;
  const agentInput = { taskId: task.taskId, prompt: task.prompt, source: task.source, memory: initial };
  if (task.mutationWindow === "before-action") world.mutate();
  const { context, counters } = createContext(task, world, initial, agentInput);
  const started = performance.now();
  await mutationStrategies[arm].run(context);
  const evaluation = world.evaluate();
  const latencyMs = performance.now() - started;
  const measured = counters();
  return {
    taskId: task.taskId,
    family: task.family,
    mutation: evaluation.changed,
    unsafeAction: evaluation.unsafe,
    completed: evaluation.correct,
    falseBlock: evaluation.falseBlock,
    changeDetected: evaluation.changed && (evaluation.correct || measured.localChecks > 0),
    recovered: evaluation.recovered,
    toctouEscape: evaluation.toctouEscape,
    connectorRequests: measured.connectorRequests,
    externalReads: measured.externalReads,
    externalWrites: measured.externalWrites,
    localChecks: measured.localChecks,
    invalidationEvents: measured.invalidationEvents,
    runtimePayloadTokens: measured.runtimePayloadTokens,
    runtimePayloadCostProxy: measured.tokenProxy.runtimePayloadCostProxy,
    runtimeOperations: measured.runtimeOperations,
    tokenProxy: measured.tokenProxy,
    agentVisibleTokenProxy: measured.tokenProxy.agentVisibleTokenProxy,
    agentVisibleCostProxy: measured.tokenProxy.agentVisibleCostProxy,
    agentTokens: null,
    providerTokens: null,
    providerCostUsd: null,
    latencyMs: Number(latencyMs.toFixed(3)),
    agentInput,
    operations: measured.operations,
    telemetry: {
      tokenTelemetry: "proxy-only",
      agentTokens: "UNKNOWN",
      providerTokens: "UNKNOWN",
      providerCostUsd: "UNKNOWN",
      runtimePayloadBilling: "NOT_BILLABLE",
      billingEvidence: false,
      provider: "not-connected",
      casEncoding: "expectedVersion-once; basedOnVersion-completed-in-runtime"
    }
  };
}

function aggregate(arm, traces) {
  const count = traces.length;
  const sum = (key) => traces.reduce((total, trace) => total + trace[key], 0);
  const rate = (key) => (traces.filter((trace) => trace[key]).length * 100) / count;
  for (const trace of traces) {
    if (trace.tokenProxy.initialAgentInput.operations !== 1) throw new Error(`agent input counted more than once for ${trace.taskId}`);
    if (trace.tokenProxy.externalOperations.operations !== trace.connectorRequests) throw new Error(`external operation telemetry mismatch for ${trace.taskId}`);
    if (trace.tokenProxy.protocolPayload.operations !== 1 + trace.localChecks) throw new Error(`protocol telemetry mismatch for ${trace.taskId}`);
  }
  const tokenCategory = (category) => summarizeTokens(
    traces.reduce((total, trace) => total + trace.tokenProxy[category].input, 0),
    traces.reduce((total, trace) => total + trace.tokenProxy[category].output, 0),
    traces.reduce((total, trace) => total + trace.tokenProxy[category].operations, 0)
  );
  const initialAgentInput = tokenCategory("initialAgentInput");
  const protocolPayload = tokenCategory("protocolPayload");
  const externalOperations = tokenCategory("externalOperations");
  const tokenTotal = initialAgentInput.total + protocolPayload.total + externalOperations.total;
  const costTotal = initialAgentInput.costUsd + protocolPayload.costUsd + externalOperations.costUsd;
  const agentVisibleTokenProxy = initialAgentInput.total + externalOperations.total;
  const agentVisibleCostProxy = initialAgentInput.costUsd + externalOperations.costUsd;
  return {
    arm,
    name: mutationStrategies[arm].name,
    tasks: count,
    mutations: sum("mutation"),
    unsafeActionsPer100: rate("unsafeAction"),
    tasksCompletedPer100: rate("completed"),
    falseBlocksPer100: rate("falseBlock"),
    changesDetectedPer100: rate("changeDetected"),
    recoveredPer100: rate("recovered"),
    toctouEscapesPer100: rate("toctouEscape"),
    connectorRequests: sum("connectorRequests"),
    connectorRequestsPer100: (sum("connectorRequests") * 100) / count,
    externalReads: sum("externalReads"),
    externalReadsPer100: (sum("externalReads") * 100) / count,
    externalWrites: sum("externalWrites"),
    externalWritesPer100: (sum("externalWrites") * 100) / count,
    localChecks: sum("localChecks"),
    invalidationEvents: sum("invalidationEvents"),
    initialAgentInputTokens: initialAgentInput.total,
    initialAgentInputTokensPerTask: initialAgentInput.total / count,
    protocolPayloadTokens: protocolPayload.total,
    protocolPayloadTokensPerTask: protocolPayload.total / count,
    externalPayloadTokens: externalOperations.total,
    externalPayloadTokensPerTask: externalOperations.total / count,
    runtimePayloadTokens: protocolPayload.total,
    runtimePayloadTokensPerTask: protocolPayload.total / count,
    runtimePayloadCostProxy: protocolPayload.costUsd,
    runtimePayloadCostProxyPerTask: protocolPayload.costUsd / count,
    runtimePayloadCostProxyPer100: (protocolPayload.costUsd * 100) / count,
    runtimeOperations: protocolPayload.operations,
    runtimeOperationsPerTask: protocolPayload.operations / count,
    runtimePayloadBillable: false,
    tokenProxyTotal: tokenTotal,
    tokenProxyPerTask: tokenTotal / count,
    agentVisibleTokenProxy,
    agentVisibleTokenProxyPerTask: agentVisibleTokenProxy / count,
    agentVisibleCostProxy,
    agentVisibleCostProxyPer100: (agentVisibleCostProxy * 100) / count,
    agentTokens: null,
    agentTokenStatus: "UNKNOWN",
    providerTokens: null,
    initialAgentInputCostProxyUsd: initialAgentInput.costUsd,
    protocolCostProxyUsd: protocolPayload.costUsd,
    externalCostProxyUsd: externalOperations.costUsd,
    costProxyUsd: costTotal,
    costProxyUsdPer100: (costTotal * 100) / count,
    providerCostUsd: null,
    p50Ms: percentile(traces.map((trace) => trace.latencyMs), 0.5),
    p95Ms: percentile(traces.map((trace) => trace.latencyMs), 0.95),
    tokenTelemetry: "proxy-only",
    billingEvidence: false
  };
}

function blindReport(candidates, tasks, round, seed) {
  const taskSetHash = sha(tasks.map(({ taskId, prompt, source }) => ({ taskId, prompt, source })));
  const normalized = candidates.map((candidate) => {
    if (candidate.traces.length !== tasks.length) throw new Error(`candidate ${candidate.id} has wrong task count`);
    return { id: candidate.id, traces: candidate.traces, metrics: aggregate(candidate.arm, candidate.traces) };
  });
  const scored = normalized.map(({ id, traces, metrics }) => ({
    id,
    metrics: Object.fromEntries(Object.entries(metrics).filter(([key]) => key !== "arm" && key !== "name")),
    eligible: metrics.unsafeActionsPer100 === 0 && metrics.tasksCompletedPer100 >= 95,
    traces
  })).sort((left, right) => Number(right.eligible) - Number(left.eligible) || left.metrics.connectorRequestsPer100 - right.metrics.connectorRequestsPer100 || left.id.localeCompare(right.id));
  return {
    format: "premisebench-agent/mutation-blind/v1",
    round,
    seed,
    taskCount: tasks.length,
    taskSetHash,
    labels: "withheld",
    candidateInputs: "agentInput contains only prompt, source and initial memory",
    mutationFamilies: { stable: 0, repairable: 0, incompatible: 0, toctou: 0 },
    pricing,
    tokenAccounting: {
      initialAgentInput: "counted once per task; the memory lookup records only its reference",
      protocolPayload: "compatibility alias for local runtimePayload",
      runtimePayload: "local memory/evidence messages, including local checks; measured but not model/provider tokens",
      runtimeOperations: "count of internal runtime payload operations",
      runtimePayloadBillable: false,
      agentVisibleTokenProxy: "initial agent input plus external request/response payloads; excludes local runtime payload",
      agentVisibleCostProxy: "synthetic proxy cost for agent-visible input and external request/response payloads; not provider billing",
      externalOperations: "one request plus one response payload per connector operation",
      doubleCounting: false
    },
    agentTokens: null,
    agentTokenStatus: "UNKNOWN",
    providerTokens: null,
    providerCostUsd: null,
    results: scored.map(({ id, metrics, eligible }) => ({ id, metrics, eligible })),
    rawRanking: scored.map(({ id }) => id),
    eligibleRanking: scored.filter(({ eligible }) => eligible).map(({ id }) => id),
    winner: scored.find(({ eligible }) => eligible)?.id ?? null,
    caveats: [
      "Deterministic local mutation control; no model provider is connected.",
      "tokenProxy and costProxy use the declared synthetic rate over disjoint payload buckets; they are not provider billing.",
      "providerTokens and providerCostUsd remain UNKNOWN/NOT_MEASURED.",
      "actIfVersion transports expectedVersion once; the runtime completes basedOnVersion after CAS accepts.",
      "The blind examiner runs in the same local process; this is not an independent holdout."
    ]
  };
}

function renderMarkdown(report) {
  const operationRows = report.results.map(({ id, metrics, eligible }) => `| ${id} | ${metrics.tasksCompletedPer100.toFixed(1)}% | ${metrics.unsafeActionsPer100.toFixed(1)} | ${metrics.recoveredPer100.toFixed(1)} | ${metrics.connectorRequestsPer100.toFixed(1)} | ${metrics.externalReadsPer100.toFixed(1)} | ${metrics.externalWritesPer100.toFixed(1)} | ${eligible ? "sí" : "no"} |`);
  const tokenRows = report.results.map(({ id, metrics }) => `| ${id} | ${metrics.initialAgentInputTokensPerTask.toFixed(1)} | ${metrics.externalPayloadTokensPerTask.toFixed(1)} | ${metrics.agentVisibleTokenProxyPerTask.toFixed(1)} | ${metrics.runtimePayloadTokensPerTask.toFixed(1)} | ${metrics.tokenProxyPerTask.toFixed(1)} | $${metrics.agentVisibleCostProxyPer100.toFixed(5)} | $${metrics.costProxyUsdPer100.toFixed(5)} |`);
  return [
    `# Campaña mutable ciega — ${report.taskCount} tareas`,
    "",
    `Ronda: **${report.round}** · semilla: **${report.seed}** · etiquetas: **${report.labels}**`,
    "",
    "## Seguridad y operaciones",
    "",
    "| ID anónimo | Completadas | Inseguras/100 | Recuperadas/100 | Peticiones/100 | Lecturas/100 | Writes/100 | Elegible |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...operationRows,
    "",
    "## Tokens y coste proxy",
    "",
    "| ID anónimo | Entrada inicial/tarea | Externo/tarea | Visible agente/tarea | Runtime local/tarea | Total proxy/tarea | Coste visible/100 | Coste total/100 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...tokenRows,
    "",
    `Orden bruto: ${report.rawRanking.join(" → ")}`,
    `Orden entre elegibles: ${report.eligibleRanking.length > 0 ? report.eligibleRanking.join(" → ") : "ninguno"}`,
    `Ganador ciego: ${report.winner ?? "ninguno"}`,
    "",
    "La entrada inicial se cuenta una vez. `Visible agente` suma la entrada inicial y los payloads externos; excluye el runtime local `NOT_BILLABLE`. `Total proxy` conserva además el runtime local. Cada operación externa cuenta una pareja request/response una vez; el lookup local solo conserva la referencia de la memoria. `Tokens proxy` y `coste proxy` usan una tarifa sintética y no son facturación del proveedor.",
    "Tokens de proveedor y coste facturado: `UNKNOWN/NOT_MEASURED`.",
    "",
    `Huella del conjunto: \`${report.taskSetHash}\``
  ].join("\n");
}

function makePublicManifest(tasks, report) {
  return {
    format: "premisebench-agent/mutation-task-manifest/v1",
    round: report.round,
    seed: report.seed,
    taskCount: report.taskCount,
    provider: "deterministic-control",
    tasks: tasks.map(({ taskId, prompt, source }) => ({ taskId, prompt, source, tools: ["check", "read", "act", "actIfVersion"] })),
    mutationSchedule: "withheld",
    labels: "withheld",
    pricing,
    tokenAccounting: "initial agent input once; protocol payloads and external request/response payloads are disjoint",
    agentVisibleTokenProxy: "published report metric: initial agent input plus external request/response payloads; excludes local runtime",
    agentVisibleCostProxy: "published report metric: synthetic proxy cost for agent-visible payloads; not provider billing",
    runtimePayloadBilling: "NOT_BILLABLE",
    runtimeOperations: "MEASURED",
    tokenTelemetry: "proxy-only",
    providerTokens: "UNKNOWN",
    providerCostUsd: "UNKNOWN",
    providerCost: "NOT_MEASURED",
    casEncoding: "expectedVersion-once; basedOnVersion-completed-in-runtime"
  };
}

async function main() {
  const tasksCount = Number(arg("tasks", "100"));
  const seed = Number(arg("seed", tasksCount === 100 ? "20260811" : "20260812"));
  const round = arg("round", tasksCount === 100 ? "100-a" : "200-a");
  if (![100, 200].includes(tasksCount)) throw new Error("--tasks must be 100 or 200");
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be an integer");
  const tasks = makeTasks(tasksCount, seed);
  const familyCounts = Object.groupBy(tasks, (task) => task.family);
  const candidates = [];
  for (const arm of mutationArmOrder) {
    const traces = [];
    for (const task of tasks) traces.push(await runArm(arm, task));
    const id = sha(`${round}:${seed}:${arm}`).slice(7, 19);
    candidates.push({ id, arm, traces });
  }
  const report = blindReport(candidates, tasks, round, seed);
  report.mutationFamilies = Object.fromEntries(Object.entries(familyCounts).map(([family, values]) => [family, values.length]));
  const directory = resolve(outputRoot, round);
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    await writeFile(resolve(directory, `candidate-${index + 1}.json`), `${JSON.stringify({ id: candidate.id, taskSetHash: report.taskSetHash, traces: candidate.traces }, null, 2)}\n`, "utf8");
  }
  await writeFile(resolve(directory, "blind-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "blind-report.md"), `${renderMarkdown(report)}\n`, "utf8");
  await writeFile(resolve(directory, "manifest.json"), `${JSON.stringify(makePublicManifest(tasks, report), null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "dataset-manifest.json"), `${JSON.stringify({ generator: "mutation-campaign.mjs", taskCount: tasksCount, seed, taskSetHash: report.taskSetHash, mutationFamilies: report.mutationFamilies, agentInputExcludes: ["mutation", "objective", "expected", "outcome", "labels"] }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    round,
    tasks: tasksCount,
    mutationFamilies: report.mutationFamilies,
    winner: report.winner,
    results: report.results.map(({ id, metrics, eligible }) => ({
      id,
      eligible,
      completed: metrics.tasksCompletedPer100,
      unsafe: metrics.unsafeActionsPer100,
      requestsPer100: metrics.connectorRequestsPer100,
      readsPer100: metrics.externalReadsPer100,
      writesPer100: metrics.externalWritesPer100,
      initialAgentInputTokensPerTask: metrics.initialAgentInputTokensPerTask,
      protocolPayloadTokensPerTask: metrics.protocolPayloadTokensPerTask,
      externalPayloadTokensPerTask: metrics.externalPayloadTokensPerTask,
      agentVisibleTokenProxyPerTask: metrics.agentVisibleTokenProxyPerTask,
      agentVisibleCostProxyPer100: metrics.agentVisibleCostProxyPer100,
      tokenProxyPerTask: metrics.tokenProxyPerTask,
      costProxyUsdPer100: metrics.costProxyUsdPer100,
      providerTokens: metrics.providerTokens,
      providerCostUsd: metrics.providerCostUsd
    }))
  }, null, 2));
}

await main();
