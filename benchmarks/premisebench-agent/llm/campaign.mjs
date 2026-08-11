import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createLlmCandidate } from "./index.mjs";
import { createWorld, makeTasks } from "../mutation-campaign.mjs";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const outputRoot = resolve(root, ".tmp/scientific-mvp/llm");
const execFileAsync = promisify(execFile);
const protocol = "premisebench-agent/1";
const defaultProvider = "openai-compatible";
const defaultSeed = 20260811;
const defaultRound = "llm-pilot";
const maxTurns = 8;
const allowedProviders = new Set(["gemini", "anthropic", "openai-compatible"]);
const toolSchema = Object.freeze([
  { type: "read", fields: ["reason"] },
  { type: "act", fields: ["action.kind", "action.value"] },
  { type: "actIfVersion", fields: ["expectedVersion", "action.kind", "action.value"] },
  { type: "reject", fields: ["reason"] },
  { type: "done", fields: [] }
]);

// Pilot limits: 20 tasks by default, sequential execution, eight model turns
// per task, and one local synthetic world. This is evidence for wiring and
// telemetry, not a provider comparison, independent holdout, or billing audit.
const armPolicies = Object.freeze({
  basic: Object.freeze({
    name: "Basic memory",
    localCheck: false,
    instruction: "Use the initial memory directly. Do not refresh before acting unless the observed protocol requires it."
  }),
  conventional: Object.freeze({
    name: "Conventional revalidation",
    localCheck: false,
    instruction: "Read the source before acting, then use the returned snapshot for an ordinary action."
  }),
  premise: Object.freeze({
    name: "PREMiSE",
    localCheck: true,
    instruction: "Use the supplied localCheck. Read only when the cached evidence is stale, and guard writes with actIfVersion. Retry from a fresh read after a rejected guarded write."
  }),
  smart: Object.freeze({
    name: "Smart Revalidate",
    localCheck: true,
    instruction: "Use the supplied localCheck as a local freshness probe. Re-read stale evidence, use actIfVersion, and retry a rejected guarded write from a fresh read."
  })
});
const defaultArms = Object.freeze(Object.keys(armPolicies));

function cliValue(argv, name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const position = argv.indexOf(`--${name}`);
  if (position >= 0 && argv[position + 1] !== undefined && !argv[position + 1].startsWith("--")) return argv[position + 1];
  return fallback;
}

function cliFlag(argv, name) {
  const value = cliValue(argv, name);
  if (value === null) return argv.includes(`--${name}`);
  return !["0", "false", "no"].includes(value.trim().toLowerCase());
}

function integerArg(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new TypeError(`--${name} must be a safe integer`);
  return parsed;
}

function parseArms(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "all") return [...defaultArms];
  const arms = [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
  if (arms.length === 0 || arms.some((arm) => !Object.hasOwn(armPolicies, arm))) throw new TypeError("--arms must contain basic, conventional, premise, or smart");
  return arms;
}

function parseArgs(argv = process.argv.slice(2)) {
  const provider = String(cliValue(argv, "provider", defaultProvider)).trim().toLowerCase();
  if (!allowedProviders.has(provider)) throw new TypeError("--provider must be gemini, anthropic, or openai-compatible");
  const model = String(cliValue(argv, "model", "")).trim();
  if (model === "") throw new TypeError("--model is required");
  const tasks = integerArg(cliValue(argv, "tasks", "20"), "tasks", { min: 1, max: 10_000 });
  const seed = integerArg(cliValue(argv, "seed", String(defaultSeed)), "seed");
  const round = String(cliValue(argv, "round", defaultRound)).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(round)) throw new TypeError("--round must be a safe directory name");
  const arms = parseArms(cliValue(argv, "arms", defaultArms.join(",")));
  const maxRetries = integerArg(cliValue(argv, "max-retries", "0"), "max-retries", { min: 0, max: 5 });
  const delayMs = integerArg(cliValue(argv, "delay-ms", "0"), "delay-ms", { min: 0, max: 60_000 });
  return Object.freeze({ provider, model, tasks, seed, round, arms, maxRetries, delayMs, dryRun: cliFlag(argv, "dry-run") });
}

function stable(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function sha(value) {
  const source = typeof value === "string" ? value : stable(value);
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sumKnown(values) {
  if (values.length === 0 || values.some((value) => finiteNumber(value) === null)) return null;
  return values.reduce((total, value) => total + value, 0);
}

function percentile(values, fraction) {
  if (values.length === 0 || values.some((value) => finiteNumber(value) === null)) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function publicTask(task) {
  return { taskId: task.taskId, prompt: task.prompt, source: task.source };
}

function taskSetHash(tasks) {
  return sha(tasks.map(publicTask));
}

function candidateConfig(args) {
  return {
    provider: args.provider,
    model: args.model,
    temperature: 0,
    maxTokens: 256,
    timeoutMs: 30_000,
    maxRetries: args.maxRetries,
    responseFormat: "json-object"
  };
}

function createCandidate(args) {
  return createLlmCandidate(candidateConfig(args));
}

function systemPrompt(arm) {
  const policy = armPolicies[arm];
  return [
    "You are a bounded action agent for a mutable source.",
    "Return exactly one JSON object per turn, with no Markdown, comments, or surrounding text.",
    `This run uses its assigned memory policy: ${policy.instruction}`,
    "Allowed response forms are:",
    '{"type":"read"}',
    '{"type":"act","action":{"kind":"apply","value":"..."}}',
    '{"type":"actIfVersion","expectedVersion":"sha256:...","action":{"kind":"apply","value":"..."}}',
    '{"type":"reject","action":{"kind":"reject"}}',
    '{"type":"done"}',
    "Use only data present in the current messages. The start message already contains the observed memory. If its content.status is active, apply its exact content.value; if it is blocked, reject. A read returns content and an opaque version. A guarded action is accepted only for the version it names.",
    "Do not explain, ask a question, or emit prose. Emit an action as soon as the current messages contain enough information. If localCheck is present, obey it before choosing whether to read.",
    "After an action result, either continue with another permitted JSON object or return done."
  ].join("\n");
}

function safeSnapshot(snapshot) {
  return {
    version: snapshot.version,
    content: structuredClone(snapshot.content)
  };
}

function checkLocalEvidence(world, memory) {
  // This compares the cached version with a private local event only. It does
  // not inspect the task family, future state, target answer, or evaluator.
  const event = world.mutationEvent;
  return { state: event === null || event.version === memory.version ? "FRESH" : "STALE" };
}

function visibleEnvelope({ task, memory, arm, world, local }) {
  const value = {
    protocol,
    type: "start",
    taskId: task.taskId,
    prompt: task.prompt,
    source: task.source,
    memory: safeSnapshot(memory),
    tools: ["read", "act", "actIfVersion", "reject"]
  };
  if (armPolicies[arm].localCheck) value.localCheck = checkLocalEvidence(world, memory);
  if (local) local.count += armPolicies[arm].localCheck ? 1 : 0;
  return value;
}

function observationEnvelope({ world, memory, arm, local, tool, result }) {
  const value = { protocol, type: "tool-result", tool, result };
  if (armPolicies[arm].localCheck) value.localCheck = checkLocalEvidence(world, memory);
  if (local) local.count += armPolicies[arm].localCheck ? 1 : 0;
  return value;
}

function recordObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedKeys(value, allowed) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError("unknown response field");
}

function optionalString(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function normalizeAction(action, { reject = false } = {}) {
  if (action === undefined) return reject ? { kind: "reject" } : null;
  if (!recordObject(action)) throw new TypeError("action must be an object");
  assertAllowedKeys(action, new Set(["kind", "value", "basedOnVersion", "reason"]));
  if (reject) return { kind: "reject" };
  if (action.kind !== "apply" || typeof action.value !== "string") throw new TypeError("apply action requires a string value");
  return { kind: "apply", value: action.value };
}

function parseAgentMessage(output) {
  if (typeof output !== "string" || output.trim() === "") throw new TypeError("empty response");
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new TypeError("response is not strict JSON");
  }
  if (!recordObject(value)) throw new TypeError("response must be a JSON object");
  if (value.protocol !== undefined && value.protocol !== protocol) throw new TypeError("protocol mismatch");
  if (typeof value.type !== "string" || !["read", "act", "actIfVersion", "reject", "done"].includes(value.type)) throw new TypeError("unsupported response type");

  if (value.type === "read") {
    assertAllowedKeys(value, new Set(["protocol", "type", "reason"]));
    optionalString(value.reason, "reason");
    return { type: "read" };
  }
  if (value.type === "act") {
    assertAllowedKeys(value, new Set(["protocol", "type", "action", "kind", "value"]));
    const action = normalizeAction(value.action ?? { kind: value.kind, value: value.value });
    if (action === null) throw new TypeError("act requires an action");
    return { type: "act", action };
  }
  if (value.type === "actIfVersion") {
    assertAllowedKeys(value, new Set(["protocol", "type", "expectedVersion", "version", "action", "kind", "value"]));
    const expectedVersion = value.expectedVersion ?? value.version;
    if (typeof expectedVersion !== "string" || expectedVersion.trim() === "") throw new TypeError("guarded action requires a version");
    const action = normalizeAction(value.action ?? { kind: value.kind, value: value.value });
    if (action === null) throw new TypeError("guarded action requires an action");
    return { type: "actIfVersion", expectedVersion, action };
  }
  if (value.type === "reject") {
    assertAllowedKeys(value, new Set(["protocol", "type", "action", "kind", "reason"]));
    optionalString(value.reason, "reason");
    return { type: "reject", action: normalizeAction(value.action ?? { kind: value.kind }, { reject: true }) };
  }
  assertAllowedKeys(value, new Set(["protocol", "type", "reason"]));
  optionalString(value.reason, "reason");
  return { type: "done" };
}

function safeProviderError(error) {
  if (!recordObject(error)) return null;
  const safe = {};
  if (typeof error.kind === "string") safe.kind = error.kind;
  if (Number.isSafeInteger(error.status)) safe.status = error.status;
  return Object.keys(safe).length === 0 ? null : safe;
}

function safeUsage(result) {
  const usage = result?.usage;
  if (!recordObject(usage)) return null;
  return {
    inputTokens: finiteNumber(usage.inputTokens),
    outputTokens: finiteNumber(usage.outputTokens),
    cachedTokens: finiteNumber(usage.cachedTokens),
    toolCalls: Number.isSafeInteger(usage.toolCalls) ? usage.toolCalls : null,
    retries: Number.isSafeInteger(usage.retries) ? usage.retries : null,
    latencyMs: finiteNumber(usage.latencyMs),
    providerCost: finiteNumber(usage.providerCost)
  };
}

function providerAttempts(result, usage) {
  if (result?.status === "NOT_RUN") return 0;
  if (result?.status === "ERROR" && result.error?.kind === "fetch-unavailable") return 0;
  if (!usage || !Number.isSafeInteger(usage.retries)) return null;
  return 1 + usage.retries;
}

function callTrace(result, requestIndex) {
  const usage = safeUsage(result);
  const output = typeof result?.output === "string" ? result.output : null;
  return {
    requestIndex,
    status: result?.status ?? "ERROR",
    promptHash: typeof result?.promptHash === "string" ? result.promptHash : null,
    outputHash: output === null ? null : sha(output),
    outputBytes: output === null ? null : Buffer.byteLength(output, "utf8"),
    finishReason: typeof result?.finishReason === "string" ? result.finishReason : null,
    providerAttempts: providerAttempts(result, usage),
    usage,
    error: safeProviderError(result?.error)
  };
}

function safeToolResult(tool, result) {
  if (tool === "read") {
    return {
      version: result.version,
      contentHash: sha(result.content),
      contentKeys: Object.keys(result.content).sort()
    };
  }
  const safe = { accepted: result?.accepted === true };
  if (typeof result?.reason === "string") safe.reason = result.reason;
  if (typeof result?.currentVersion === "string") safe.currentVersion = result.currentVersion;
  return safe;
}

function safeAction(action, type) {
  const safe = { type };
  if (action?.kind) safe.kind = action.kind;
  if (typeof action?.value === "string") {
    safe.valueHash = sha(action.value);
    safe.valueBytes = Buffer.byteLength(action.value, "utf8");
  }
  if (typeof action?.expectedVersion === "string") safe.expectedVersion = action.expectedVersion;
  return safe;
}

function providerStatus(calls) {
  if (calls.some((call) => call.status === "ERROR")) return "ERROR";
  if (calls.some((call) => call.status === "NOT_RUN")) return "NOT_RUN";
  return calls.length > 0 && calls.every((call) => call.status === "OK") ? "OK" : "NOT_RUN";
}

function summarizeCalls(calls) {
  const usages = calls.map((call) => call.usage);
  const attempted = calls.filter((call) => call.status !== "NOT_RUN");
  const latency = calls.map((call) => call.status === "NOT_RUN" ? null : call.usage?.latencyMs ?? null);
  const retryTelemetryIncomplete = calls.some((call) => (call.usage?.retries ?? 0) > 0);
  const completeUsage = attempted.length > 0 && !retryTelemetryIncomplete && attempted.every((call) => ["inputTokens", "outputTokens", "cachedTokens", "providerCost"].every((key) => finiteNumber(call.usage?.[key]) !== null));
  const tokenMetric = (key) => retryTelemetryIncomplete || attempted.length === 0 ? null : sumKnown(usages.map((usage) => usage?.[key] ?? null));
  return {
    completionRequests: calls.length,
    llmCalls: sumKnown(calls.map((call) => call.providerAttempts)),
    providerAttempts: sumKnown(calls.map((call) => call.providerAttempts)),
    retries: sumKnown(usages.map((usage) => usage?.retries ?? null)),
    inputTokens: tokenMetric("inputTokens"),
    outputTokens: tokenMetric("outputTokens"),
    cachedTokens: tokenMetric("cachedTokens"),
    latencyMs: attempted.length === 0 ? null : sumKnown(latency),
    providerCost: tokenMetric("providerCost"),
    toolCalls: tokenMetric("toolCalls"),
    usageStatus: attempted.length === 0 ? "NOT_RUN" : completeUsage ? "COMPLETE" : retryTelemetryIncomplete ? "PARTIAL_RETRY_TELEMETRY" : "PARTIAL_OR_UNKNOWN"
  };
}

function traceEvaluation(status, evaluation) {
  if (status !== "OK") return null;
  return {
    completed: evaluation.correct,
    unsafeAction: evaluation.unsafe,
    falseBlock: evaluation.falseBlock,
    changed: evaluation.changed,
    recovered: evaluation.recovered,
    toctouEscape: evaluation.toctouEscape,
    actionAttempted: evaluation.action !== null
  };
}

async function runAgent({ candidate, task, arm, round, delayMs = 0 }) {
  const world = createWorld(task);
  const initial = world.initial;
  if (task.mutationWindow === "before-action") world.mutate();

  const local = { count: 0, states: [] };
  let memory = initial;
  const messages = [{ role: "system", content: systemPrompt(arm) }];
  const start = visibleEnvelope({ task, memory, arm, world, local });
  if (armPolicies[arm].localCheck) local.states.push(start.localCheck.state);
  messages.push({ role: "user", content: JSON.stringify(start) });

  const calls = [];
  const actions = [];
  let protocolErrors = 0;
  let agentStatus = null;
  const started = performance.now();

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const requestId = `${round}:${arm}:${task.taskId}:${turn + 1}`;
    let result;
    try {
      result = await candidate.complete({ taskId: task.taskId, requestId, messages });
    } catch {
      result = { status: "ERROR", error: { kind: "candidate-invocation" }, usage: null };
    }
    const call = callTrace(result, calls.length + 1);
    calls.push(call);
    if (delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));

    if (result.status === "NOT_RUN") {
      agentStatus = "NOT_RUN";
      break;
    }
    if (result.status === "ERROR") {
      agentStatus = "ERROR";
      break;
    }

    let message;
    try {
      message = parseAgentMessage(result.output);
    } catch {
      protocolErrors += 1;
      messages.push({ role: "assistant", content: "[invalid JSON response omitted]" });
      const feedback = observationEnvelope({
        world,
        memory,
        arm,
        local,
        tool: "protocol",
        result: { accepted: false, reason: "invalid-json-action" }
      });
      if (armPolicies[arm].localCheck) local.states.push(feedback.localCheck.state);
      messages.push({ role: "user", content: JSON.stringify(feedback) });
      continue;
    }

    messages.push({ role: "assistant", content: JSON.stringify(message) });
    if (message.type === "done") {
      agentStatus = "OK";
      break;
    }

    let tool;
    let resultValue;
    if (message.type === "read") {
      tool = "read";
      const snapshot = world.read();
      memory = snapshot;
      resultValue = safeSnapshot(snapshot);
    } else if (message.type === "act") {
      tool = "act";
      resultValue = world.act(message.action);
    } else if (message.type === "actIfVersion") {
      tool = "actIfVersion";
      resultValue = world.actIfVersion(message.expectedVersion, message.action);
    } else {
      tool = "reject";
      resultValue = world.act({ kind: "reject" });
    }
    actions.push({
      turn: turn + 1,
      action: safeAction(message.action, message.type),
      result: safeToolResult(tool, resultValue)
    });
    const feedback = observationEnvelope({
      world,
      memory,
      arm,
      local,
      tool,
      result: tool === "read" ? resultValue : safeToolResult(tool, resultValue)
    });
    if (armPolicies[arm].localCheck) local.states.push(feedback.localCheck.state);
    messages.push({ role: "user", content: JSON.stringify(feedback) });
  }

  if (agentStatus === null) agentStatus = "ERROR";
  const evaluation = world.evaluate();
  const llm = summarizeCalls(calls);
  return {
    taskId: task.taskId,
    arm,
    status: agentStatus,
    providerStatus: providerStatus(calls),
    agentStatus,
    taskLatencyMs: Number((performance.now() - started).toFixed(3)),
    localChecks: local.count,
    localCheckStates: local.states,
    externalReads: actions.filter(({ action }) => action.type === "read").length,
    externalWrites: actions.filter(({ action }) => ["act", "actIfVersion", "reject"].includes(action.type)).length,
    protocolErrors,
    llm,
    calls,
    actions,
    evaluation: traceEvaluation(agentStatus, evaluation)
  };
}

function campaignStatus(items) {
  if (items.some((item) => item.status === "ERROR")) return "ERROR";
  if (items.some((item) => item.status === "NOT_RUN")) return "NOT_RUN";
  return "OK";
}

function rate(traces, key, comparable) {
  if (!comparable) return null;
  return (traces.filter((trace) => trace.evaluation?.[key] === true).length * 100) / traces.length;
}

function aggregateArm(arm, traces) {
  const status = campaignStatus(traces);
  const comparable = status === "OK";
  const metric = (key) => sumKnown(traces.map((trace) => trace.llm[key]));
  const latencyValues = traces.map((trace) => trace.llm.latencyMs);
  const completed = comparable ? traces.filter((trace) => trace.evaluation.completed).length : null;
  const unsafeActions = comparable ? traces.filter((trace) => trace.evaluation.unsafeAction).length : null;
  const actionAttempts = comparable ? traces.filter((trace) => trace.evaluation.actionAttempted).length : null;
  const safeAttempts = actionAttempts === null ? null : actionAttempts - unsafeActions;
  const providerCost = metric("providerCost");
  const usageStatuses = new Set(traces.map((trace) => trace.llm.usageStatus));
  return {
    arm,
    name: armPolicies[arm].name,
    status,
    tasks: traces.length,
    completed,
    completedRate: comparable ? (completed * 100) / traces.length : null,
    unsafeActions,
    unsafeRate: rate(traces, "unsafeAction", comparable),
    falseBlocks: comparable ? traces.filter((trace) => trace.evaluation.falseBlock).length : null,
    falseBlockRate: rate(traces, "falseBlock", comparable),
    recoveredRate: rate(traces, "recovered", comparable),
    toctouEscapeRate: rate(traces, "toctouEscape", comparable),
    actionAttempts,
    safeAttempts,
    safeSuccessfulTasks: completed,
    completionRequests: metric("completionRequests"),
    llmCalls: metric("llmCalls"),
    providerAttempts: metric("providerAttempts"),
    retries: metric("retries"),
    inputTokens: metric("inputTokens"),
    outputTokens: metric("outputTokens"),
    cachedTokens: metric("cachedTokens"),
    latencyMs: metric("latencyMs"),
    latencyP50Ms: percentile(latencyValues, 0.5),
    latencyP95Ms: percentile(latencyValues, 0.95),
    providerCost,
    providerCostPerSafeAttempt: providerCost === null || safeAttempts === null || safeAttempts === 0 ? null : providerCost / safeAttempts,
    providerCsfa: providerCost === null || completed === null || completed === 0 ? null : providerCost / completed,
    totalCsfa: null,
    totalCostStatus: "UNKNOWN_CONNECTOR_AND_COMPUTE_COST",
    wastedTasks: completed === null ? null : traces.length - completed,
    wastedWorkRate: completed === null ? null : (traces.length - completed) / traces.length,
    tokensPerSafeSuccessfulTask: completed === null || completed === 0 || metric("inputTokens") === null || metric("outputTokens") === null
      ? null
      : (metric("inputTokens") + metric("outputTokens")) / completed,
    toolCalls: metric("toolCalls"),
    usageStatus: usageStatuses.size === 1 ? [...usageStatuses][0] : "MIXED",
    localChecks: sumKnown(traces.map((trace) => trace.localChecks)),
    externalReads: sumKnown(traces.map((trace) => trace.externalReads)),
    externalWrites: sumKnown(traces.map((trace) => trace.externalWrites)),
    protocolErrors: sumKnown(traces.map((trace) => trace.protocolErrors)),
    statusCounts: Object.fromEntries(["OK", "NOT_RUN", "ERROR"].map((value) => [value, traces.filter((trace) => trace.status === value).length]))
  };
}

function armResults(arms, traces) {
  return arms.map((arm) => aggregateArm(arm, traces.filter((trace) => trace.arm === arm)));
}

function blindCandidateId(args, arm) {
  return sha(`${args.round}:${args.seed}:${arm}`).slice(7, 19);
}

function blindReport(args, results, taskHash) {
  const comparable = results.length > 0 && results.every((result) => result.status === "OK");
  if (!comparable) {
    return {
      format: "premisebench-agent/llm-blind/v1",
      status: "NOT_COMPARABLE",
      reason: "at least one arm has provider ERROR or NOT_RUN; no partial ranking is emitted",
      taskCount: args.tasks,
      taskSetHash: taskHash,
      results: []
    };
  }
  return {
    format: "premisebench-agent/llm-blind/v1",
    status: "READY_FOR_EXAMINER",
    taskCount: args.tasks,
    taskSetHash: taskHash,
    results: results.map((result) => {
      const attempts = result.actionAttempts;
      const safeAttempts = attempts === null ? null : attempts - result.unsafeActions;
      const metrics = {
        tasks: result.tasks,
        safeCompletionRate: result.completedRate / 100,
        unsafeActionRate: result.unsafeRate / 100,
        attempts,
        safeAttempts,
        safeSuccessfulTasks: result.completed,
        unsafeActions: result.unsafeActions,
        falseBlocks: result.falseBlocks,
        connectorRequests: result.completionRequests,
        externalReads: result.externalReads
      };
      if (result.providerCost !== null) {
        metrics.providerCostUsd = result.providerCost;
        metrics.costPerSafeAttemptUsd = safeAttempts > 0 ? result.providerCost / safeAttempts : null;
        metrics.costPerSafeSuccessfulTaskUsd = result.completed > 0 ? result.providerCost / result.completed : null;
        metrics.csfaUsd = result.completed > 0 ? result.providerCost / result.completed : null;
      }
      return { id: blindCandidateId(args, result.arm), metrics };
    })
  };
}

function fixed(value, digits = 2) {
  return finiteNumber(value) === null ? "UNKNOWN" : value.toFixed(digits);
}

function reportMarkdown({ args, manifest, summary }) {
  const rows = summary.results.map((result) => {
    const metrics = result.metrics;
    return `| ${result.arm} | ${result.status} | ${fixed(metrics.completedRate, 1)}% | ${fixed(metrics.unsafeRate, 1)}% | ${fixed(metrics.llmCalls, 0)} | ${fixed(metrics.inputTokens, 0)} | ${fixed(metrics.outputTokens, 0)} | ${fixed(metrics.retries, 0)} | ${fixed(metrics.latencyMs)} | ${metrics.providerCost === null ? "UNKNOWN" : `$${fixed(metrics.providerCost, 6)}`} | ${metrics.providerCsfa === null ? "UNKNOWN" : `$${fixed(metrics.providerCsfa, 8)}`} | UNKNOWN |`;
  });
  return [
    "# Real-LLM campaign pilot",
    "",
    `Status: **${summary.status}** · provider: **${args.provider}** · model: **${args.model}**`,
    `Round: **${args.round}** · seed: **${args.seed}** · tasks: **${args.tasks}** · arms: **${args.arms.join(", ")}**`,
    "",
    "> This pilot uses a private deterministic mutation world and a real provider adapter. It is not an independent holdout, a production reliability result, or a billing audit.",
    "",
    "## Provider and agent telemetry",
    "",
    "| Arm | Status | Completed / 100 | Unsafe / 100 | LLM calls | Input tokens | Output tokens | Retries | Latency ms | providerCost | Provider CSFA | Total CSFA |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "`LLM calls` counts provider attempts; `completionRequests` and retry counts remain in `summary.json`. `UNKNOWN`/`null` means the provider did not supply a reliable measurement or the arm was not comparable. It is never a zero-filled estimate. `providerCost` and Provider CSFA are reported only when returned by the provider response; Total CSFA remains UNKNOWN until connector and compute costs are instrumented.",
    "",
    "## Boundary and reproducibility",
    "",
    `- Task-set hash: \`${manifest.taskSetHash}\`. The agent input contains only task prompt/source, initial or freshly read memory, tool results, and the local freshness check for PREMiSE/Smart.`,
    "- The mutation schedule, evaluator fields, target result, and labels stay outside the agent messages; traces store hashes and safe telemetry rather than raw model output.",
    `- Artifacts contain no credential values. The configured credential environment name is \`${manifest.credentialEnv}\` only.`,
    `- The eight-turn cap, sequential execution, JSON parser, single local world, ${args.delayMs}ms inter-call delay and provider-reported usage limits this pilot; repeat across providers, seeds, and an external holdout before making a comparative claim.`,
    `- Blind examiner status: **${manifest.blindExaminerStatus}**. A partial provider campaign is never ranked.`,
    "",
    "## Artifacts",
    "",
    "`manifest.json`, `summary.json`, `traces.jsonl`, and this `report.md` are written under `.tmp/scientific-mvp/llm/<round>/`."
  ].join("\n");
}

function publicManifest(args, candidate, tasks, status, hash) {
  return {
    format: "premisebench-agent/llm-campaign/v1",
    benchmark: "PremiseBench-Agent",
    status,
    provider: candidate.config.provider,
    model: candidate.config.model,
    responseFormat: candidate.config.responseFormat,
    runtime: { node: process.version, fetch: "platform-native", sdk: "none" },
    modelSeed: "NOT_SUPPORTED_BY_ADAPTER",
    region: "UNKNOWN",
    credentialEnv: candidate.config.credentialEnv,
    round: args.round,
    seed: args.seed,
    taskCount: tasks.length,
    arms: args.arms,
    taskSetHash: hash,
    mutationWorld: "private:createWorld(task)",
    mutationSchedule: "private",
    labels: "withheld-from-agent",
    agentProtocol: protocol,
    toolSchemaHash: sha(toolSchema),
    systemPromptHashes: Object.fromEntries(args.arms.map((arm) => [arm, sha(systemPrompt(arm))])),
    taskPromptHashes: Object.fromEntries(tasks.map((task) => [task.taskId, sha(task.prompt)])),
    responseTypes: ["read", "act", "actIfVersion", "reject", "done"],
    agentInputExcludes: ["mutation", "expected", "oracle", "labels", "family", "outcome", "groundTruth"],
    localCheckArms: args.arms.filter((arm) => armPolicies[arm].localCheck),
    maxTurns,
    maxRetries: args.maxRetries,
    delayMs: args.delayMs,
    usagePolicy: {
      providerTokens: "provider response usage only; missing values remain null",
      providerCost: "provider response cost only; no price-list estimate",
      retries: "included in providerAttempts and reported separately",
      latency: "candidate-reported per completion, summed without filling NOT_RUN as zero"
    },
    artifacts: ["manifest.json", "summary.json", "traces.jsonl", "report.md", "blind-report.json", "examined-report.json", "mapping.private.json"],
    blindExaminerStatus: status === "OK" ? "READY_FOR_EXAMINER" : "NOT_COMPARABLE",
    generatedAt: new Date().toISOString(),
    tasks: tasks.map(publicTask)
  };
}

async function writeArtifacts({ args, candidate, tasks, traces, summary, blind, examined }) {
  const hash = taskSetHash(tasks);
  const manifest = publicManifest(args, candidate, tasks, summary.status, hash);
  const directory = resolve(outputRoot, args.round);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "traces.jsonl"), `${traces.map((trace) => JSON.stringify(trace)).join("\n")}\n`, "utf8");
  await writeFile(resolve(directory, "blind-report.json"), `${JSON.stringify(blind, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "examined-report.json"), `${JSON.stringify(examined, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "mapping.private.json"), `${JSON.stringify(Object.fromEntries(args.arms.map((arm) => [blindCandidateId(args, arm), arm])), null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "report.md"), `${reportMarkdown({ args, manifest, summary })}\n`, "utf8");
  return { manifest, directory };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const candidate = createCandidate(args);
  if (args.dryRun) {
    const result = {
      status: "DRY_RUN",
      dryRun: true,
      networkCalled: false,
      artifactsWritten: false,
      provider: candidate.config.provider,
      model: candidate.config.model,
      credentialEnv: candidate.config.credentialEnv,
      tasks: args.tasks,
      seed: args.seed,
      round: args.round,
      arms: args.arms,
      maxRetries: args.maxRetries,
      delayMs: args.delayMs
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const tasks = makeTasks(args.tasks, args.seed);
  const traces = [];
  for (const task of tasks) {
    for (const arm of args.arms) traces.push(await runAgent({ candidate, task, arm, round: args.round, delayMs: args.delayMs }));
  }
  const results = armResults(args.arms, traces);
  const taskHash = taskSetHash(tasks);
  const blind = blindReport(args, results, taskHash);
  const artifactDirectory = resolve(outputRoot, args.round);
  await mkdir(artifactDirectory, { recursive: true });
  const blindPath = resolve(artifactDirectory, "blind-report.json");
  const examinedPath = resolve(artifactDirectory, "examined-report.json");
  await writeFile(blindPath, `${JSON.stringify(blind, null, 2)}\n`, "utf8");
  let examined = { format: "premisebench-agent/llm-blind-examined/v1", state: "NOT_RUN", winner: null, results: [] };
  if (blind.status === "READY_FOR_EXAMINER") {
    await execFileAsync(process.execPath, [
      resolve(root, "benchmarks/premisebench-agent/scientific/examiner.mjs"),
      `--input=${blindPath}`,
      `--output=${examinedPath}`
    ], { cwd: root, windowsHide: true });
    examined = JSON.parse(await readFile(examinedPath, "utf8"));
  }
  const summary = {
    format: "premisebench-agent/llm-campaign-summary/v1",
    status: campaignStatus(results),
    provider: candidate.config.provider,
    model: candidate.config.model,
    credentialEnv: candidate.config.credentialEnv,
    round: args.round,
    seed: args.seed,
    taskCount: tasks.length,
    taskSetHash: taskHash,
    blindExaminerStatus: blind.status,
    blindWinner: examined.winner ?? null,
    results: results.map((metrics) => ({ arm: metrics.arm, name: metrics.name, status: metrics.status, metrics })),
    caveats: [
      "This is a real-provider pilot over one local mutation world, not an independent holdout.",
      "The agent receives no mutation schedule, target result, evaluator label, or hidden oracle.",
      "Provider usage and providerCost are null when the adapter or provider does not measure them; NOT_RUN and ERROR are not converted into zero.",
      "Raw model responses and credential values are not written; traces keep hashes, protocol actions, and safe telemetry only."
    ]
  };
  const { manifest, directory } = await writeArtifacts({ args, candidate, tasks, traces, summary, blind, examined });
  const result = { status: summary.status, round: args.round, tasks: tasks.length, arms: args.arms, directory, manifest: manifest.artifacts, results };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

export {
  aggregateArm,
  blindReport,
  main,
  parseAgentMessage,
  parseArgs,
  runAgent,
  systemPrompt,
  visibleEnvelope
};
