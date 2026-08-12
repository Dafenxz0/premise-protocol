import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createLlmCandidate } from "./index.mjs";
import { createWorld, makeTasks } from "../mutation-campaign.mjs";
import { HARD_RISK_LEVELS, makeHardTasks } from "../scientific/hard-scenarios.mjs";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const execFileAsync = promisify(execFile);
const protocol = "premisebench-agent/1";
const defaultProvider = "openai-compatible";
const defaultSeed = 20260811;
const defaultRound = "llm-pilot";
const maxTurns = 8;
const allowedProviders = new Set(["gemini", "anthropic", "openai-compatible", "openrouter", "zai"]);
const toolSchema = Object.freeze([
  { type: "read", fields: ["reason"] },
  { type: "act", fields: ["action.kind", "action.value"] },
  { type: "actIfVersion", fields: ["expectedVersion", "action.kind", "action.value"] },
  { type: "reject", fields: ["reason"] }
]);

// Pilot limits: 20 tasks by default, sequential execution, eight model turns
// per task, and one local synthetic world. This is evidence for wiring and
// telemetry, not a provider comparison, independent holdout, or billing audit.
const armPolicies = Object.freeze({
  basic: Object.freeze({
    name: "Basic memory",
    localCheck: false,
    eventSignal: false,
    tools: Object.freeze(["act", "reject"]),
    instruction: "Use the initial memory directly and do not refresh. For an active snapshot, apply its exact value and include its memory.version as basedOnVersion; this is an annotation, not a guarded write. For blocked evidence, reject locally."
  }),
  conventional: Object.freeze({
    name: "Conventional revalidation",
    localCheck: false,
    eventSignal: false,
    tools: Object.freeze(["read", "act", "reject"]),
    instruction: "Read the source before acting, then use the returned snapshot. For an active snapshot, apply its exact value and include that snapshot version as basedOnVersion; this ordinary write is not guarded against TOCTOU. For blocked evidence, reject locally."
  }),
  always: Object.freeze({
    name: "Always revalidate",
    localCheck: false,
    eventSignal: false,
    tools: Object.freeze(["read", "actIfVersion", "reject"]),
    instruction: "Read the source before every decision, then use actIfVersion with the returned version. Retry from the atomic conflict snapshot when a guarded write is rejected; reject blocked evidence locally."
  }),
  premise: Object.freeze({
    name: "PREMiSE",
    localCheck: true,
    eventSignal: false,
    tools: Object.freeze(["read", "actIfVersion", "reject"]),
    instruction: "Use the supplied localCheck. Read only when the cached evidence is stale, and guard writes with actIfVersion. If a rejected guarded write returns an atomic current snapshot, treat it as new evidence and retry from that snapshot without a redundant read; otherwise read before retrying."
  }),
  smart: Object.freeze({
    name: "Smart Revalidate",
    localCheck: false,
    eventSignal: true,
    tools: Object.freeze(["read", "actIfVersion", "reject"]),
    instruction: "Use the eventSignal as a cache invalidation hint, without PREMiSE localCheck semantics. Re-read only after INVALIDATE, use actIfVersion, and retry a rejected guarded write from the atomic conflict snapshot."
  })
});
const defaultArms = Object.freeze(Object.keys(armPolicies));

function allowedResponseTypes(arm) {
  return new Set(armPolicies[arm]?.tools ?? ["read", "act", "actIfVersion", "reject"]);
}

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
  if (arms.length === 0 || arms.some((arm) => !Object.hasOwn(armPolicies, arm))) throw new TypeError("--arms must contain basic, conventional, always, premise, or smart");
  return arms;
}

function parseArgs(argv = process.argv.slice(2)) {
  const provider = String(cliValue(argv, "provider", defaultProvider)).trim().toLowerCase();
  if (!allowedProviders.has(provider)) throw new TypeError("--provider must be gemini, anthropic, openai-compatible, openrouter, or zai");
  const model = String(cliValue(argv, "model", "")).trim();
  if (model === "") throw new TypeError("--model is required");
  const tasks = integerArg(cliValue(argv, "tasks", "20"), "tasks", { min: 1, max: 10_000 });
  const seed = integerArg(cliValue(argv, "seed", String(defaultSeed)), "seed");
  const scenario = String(cliValue(argv, "scenario", "standard")).trim().toLowerCase();
  if (!new Set(["standard", "hard"]).has(scenario)) throw new TypeError("--scenario must be standard or hard");
  const volatility = integerArg(cliValue(argv, "volatility", "50"), "volatility", { min: 0, max: 100 });
  const riskLevels = parseRiskLevels(cliValue(argv, "risk-levels", HARD_RISK_LEVELS.join(",")));
  const round = String(cliValue(argv, "round", defaultRound)).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(round)) throw new TypeError("--round must be a safe directory name");
  const arms = parseArms(cliValue(argv, "arms", defaultArms.join(",")));
  const maxRetries = integerArg(cliValue(argv, "max-retries", "0"), "max-retries", { min: 0, max: 5 });
  const retryDelayMs = integerArg(cliValue(argv, "retry-delay-ms", "1000"), "retry-delay-ms", { min: 0, max: 300_000 });
  const configuredMaxTurns = integerArg(cliValue(argv, "max-turns", String(maxTurns)), "max-turns", { min: 1, max: maxTurns });
  const maxTokens = integerArg(cliValue(argv, "max-tokens", "256"), "max-tokens", { min: 1, max: 32_768 });
  const delayMs = integerArg(cliValue(argv, "delay-ms", "0"), "delay-ms", { min: 0, max: 60_000 });
  const maxProviderRequests = integerArg(cliValue(argv, "max-provider-requests", "0"), "max-provider-requests", { min: 0, max: 10_000 });
  const minRequestIntervalMs = integerArg(cliValue(argv, "min-request-interval-ms", "0"), "min-request-interval-ms", { min: 0, max: 300_000 });
  const maxProviderTokens = integerArg(cliValue(argv, "max-provider-tokens", "0"), "max-provider-tokens", { min: 0, max: 10_000_000 });
  if (maxProviderRequests > 0 && maxRetries > 0) throw new TypeError("--max-retries must be 0 when --max-provider-requests is set");
  const completeCampaignRequestCeiling = tasks * arms.length * configuredMaxTurns;
  if (maxProviderRequests > 0 && maxProviderRequests < completeCampaignRequestCeiling) {
    throw new RangeError(`--max-provider-requests must be at least ${completeCampaignRequestCeiling} for complete candidate coverage`);
  }
  const responseFormat = String(cliValue(argv, "response-format", "json-object")).trim().toLowerCase();
  if (!["json-object", "none"].includes(responseFormat)) throw new TypeError("--response-format must be json-object or none");
  const endpointValue = String(cliValue(argv, "endpoint", "")).trim();
  const credentialEnvValue = String(cliValue(argv, "credential-env", "")).trim();
  const configuredOutputRoot = String(cliValue(argv, "output", ".tmp/scientific-mvp/llm")).trim();
  return Object.freeze({
    provider,
    model,
    tasks,
    seed,
    scenario,
    volatility,
    riskLevels,
    round,
    outputRoot: resolve(root, configuredOutputRoot),
    arms,
    maxRetries,
    retryDelayMs,
    maxTurns: configuredMaxTurns,
    maxTokens,
    delayMs,
    maxProviderRequests,
    minRequestIntervalMs,
    maxProviderTokens,
    responseFormat,
    endpoint: endpointValue || null,
    credentialEnv: credentialEnvValue || null,
    requireLive: cliFlag(argv, "require-live"),
    dryRun: cliFlag(argv, "dry-run")
  });
}

function parseRiskLevels(value) {
  const levels = [...new Set(String(value).split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
  if (levels.length === 0 || levels.some((level) => !HARD_RISK_LEVELS.includes(level))) throw new TypeError(`--risk-levels must use ${HARD_RISK_LEVELS.join(", ")}`);
  return levels;
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
  return {
    taskId: task.taskId,
    prompt: task.prompt,
    source: task.source,
    ...(typeof task.risk === "string" ? { risk: task.risk } : {}),
    memory: safeSnapshot({ version: sha(task.initial), content: task.initial })
  };
}

function taskSetHash(tasks) {
  return sha(tasks.map(publicTask));
}

function privateScheduleHash(tasks) {
  return sha(tasks.map((task) => ({
    taskId: task.taskId,
    mutation: task.mutation,
    mutationWindow: task.mutationWindow,
    events: task.events,
    evaluator: task.evaluator,
    hardCase: task.hardCase
  })));
}

function candidateConfig(args) {
  return {
    provider: args.provider,
    model: args.model,
    temperature: 0,
    maxTokens: args.maxTokens,
    timeoutMs: 30_000,
    maxRetries: args.maxRetries,
    retryDelayMs: args.retryDelayMs,
    responseFormat: args.responseFormat === "none" ? null : "json-object",
    ...(args.endpoint ? { endpoint: args.endpoint } : {}),
    ...(args.credentialEnv ? { credentialEnv: args.credentialEnv } : {})
  };
}

function createCandidate(args) {
  const candidate = createLlmCandidate(candidateConfig(args));
  let requestCount = 0;
  let lastRequestAt = 0;
  let tokenCount = 0;
  let tokenBudgetUnknown = false;

  async function complete(request = {}) {
    if (args.maxProviderRequests > 0 && requestCount >= args.maxProviderRequests) {
      return {
        status: "ERROR",
        error: { kind: "request-budget-exhausted" },
        usage: { inputTokens: null, outputTokens: null, cachedTokens: null, toolCalls: 0, retries: 0, latencyMs: 0, providerCost: null }
      };
    }
    if (args.maxProviderTokens > 0 && tokenBudgetUnknown) {
      return {
        status: "ERROR",
        error: { kind: "token-budget-unknown" },
        usage: { inputTokens: null, outputTokens: null, cachedTokens: null, toolCalls: 0, retries: 0, latencyMs: 0, providerCost: null }
      };
    }
    if (args.maxProviderTokens > 0 && tokenCount >= args.maxProviderTokens) {
      return {
        status: "ERROR",
        error: { kind: "token-budget-exhausted" },
        usage: { inputTokens: null, outputTokens: null, cachedTokens: null, toolCalls: 0, retries: 0, latencyMs: 0, providerCost: null }
      };
    }
    const waitMs = Math.max(0, args.minRequestIntervalMs - (Date.now() - lastRequestAt));
    if (waitMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs));
    requestCount += 1;
    lastRequestAt = Date.now();
    const result = await candidate.complete(request);
    const inputTokens = finiteNumber(result?.usage?.inputTokens);
    const outputTokens = finiteNumber(result?.usage?.outputTokens);
    if (args.maxProviderTokens > 0 && result.status === "OK" && (inputTokens === null || outputTokens === null)) {
      tokenBudgetUnknown = true;
      return { ...result, status: "ERROR", output: null, error: { kind: "token-budget-unknown-after-call" } };
    }
    if (inputTokens !== null && outputTokens !== null) tokenCount += inputTokens + outputTokens;
    if (args.maxProviderTokens > 0 && tokenCount > args.maxProviderTokens) {
      return { ...result, status: "ERROR", output: null, error: { kind: "token-budget-exceeded" } };
    }
    return result;
  }

  return Object.freeze({
    ...candidate,
    complete,
    requestStats: () => Object.freeze({
      requestsStarted: requestCount,
      maxProviderRequests: args.maxProviderRequests,
      minRequestIntervalMs: args.minRequestIntervalMs,
      tokensObserved: tokenCount,
      maxProviderTokens: args.maxProviderTokens
    })
  });
}

function systemPrompt(arm) {
  const policy = armPolicies[arm];
  const forms = {
    read: '{"type":"read"}',
    act: '{"type":"act","action":{"kind":"apply","value":"...","basedOnVersion":"sha256:..."}}',
    actIfVersion: '{"type":"actIfVersion","expectedVersion":"sha256:...","action":{"kind":"apply","value":"..."}}',
    reject: '{"type":"reject","action":{"kind":"reject"}}'
  };
  return [
    "You are a bounded action agent for a mutable source.",
    "Return exactly one JSON object per turn, with no Markdown, comments, or surrounding text.",
    `This run uses its assigned memory policy: ${policy.instruction}`,
    "Allowed response forms are:",
    ...[...allowedResponseTypes(arm)].map((type) => forms[type]),
    "Use only data present in the current messages. The start message already contains the observed memory. If its content.status is active, apply its exact content.value; if it is blocked, reject. A read returns content and an opaque version. A normal action may annotate basedOnVersion but is not guarded. A guarded action is accepted only for the version it names.",
    "Do not explain, ask a question, or emit prose. Emit an action as soon as the assigned policy and current messages contain enough information. If localCheck or eventSignal is present, obey it before choosing whether to read.",
    "If a response was rejected as invalid, emit a fresh permitted JSON object. A reject or accepted action is terminal."
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
    ...(typeof task.risk === "string" ? { risk: task.risk } : {}),
    memory: safeSnapshot(memory),
    tools: [...armPolicies[arm].tools]
  };
  if (armPolicies[arm].localCheck) value.localCheck = checkLocalEvidence(world, memory);
  if (armPolicies[arm].eventSignal) value.eventSignal = world.mutationEvent === null ? "NONE" : "INVALIDATE";
  if (local) {
    local.count += armPolicies[arm].localCheck ? 1 : 0;
    local.signals += armPolicies[arm].eventSignal ? 1 : 0;
  }
  return value;
}

function observationEnvelope({ world, memory, arm, local, tool, result }) {
  const value = { protocol, type: "tool-result", tool, result };
  if (armPolicies[arm].localCheck) value.localCheck = checkLocalEvidence(world, memory);
  if (armPolicies[arm].eventSignal) value.eventSignal = world.mutationEvent === null ? "NONE" : "INVALIDATE";
  if (local) {
    local.count += armPolicies[arm].localCheck ? 1 : 0;
    local.signals += armPolicies[arm].eventSignal ? 1 : 0;
  }
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
  return {
    kind: "apply",
    value: action.value,
    ...(typeof action.basedOnVersion === "string" ? { basedOnVersion: action.basedOnVersion } : {})
  };
}

function parseAgentMessage(output, arm) {
  if (!Object.hasOwn(armPolicies, arm)) throw new TypeError("response arm is required");
  if (typeof output !== "string" || output.trim() === "") throw new TypeError("empty response");
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new TypeError("response is not strict JSON");
  }
  if (!recordObject(value)) throw new TypeError("response must be a JSON object");
  if (value.protocol !== undefined && value.protocol !== protocol) throw new TypeError("protocol mismatch");
  if (typeof value.type !== "string" || !["read", "act", "actIfVersion", "reject"].includes(value.type)) throw new TypeError("unsupported response type");
  if (arm !== null && !allowedResponseTypes(arm).has(value.type)) throw new TypeError(`response type ${value.type} is not allowed for this arm`);

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
  throw new TypeError("unsupported response type");
}

function safeProviderError(error) {
  if (!recordObject(error)) return null;
  const safe = {};
  if (typeof error.kind === "string") safe.kind = error.kind;
  if (Number.isSafeInteger(error.status)) safe.status = error.status;
  if (typeof error.code === "string" || Number.isSafeInteger(error.code)) safe.code = error.code;
  if (typeof error.message === "string") safe.message = error.message.slice(0, 256);
  return Object.keys(safe).length === 0 ? null : safe;
}

function safeUsage(result) {
  const usage = result?.usage;
  if (!recordObject(usage)) return null;
  return {
    inputTokens: finiteNumber(usage.inputTokens),
    outputTokens: finiteNumber(usage.outputTokens),
    totalTokens: finiteNumber(usage.totalTokens),
    cachedTokens: finiteNumber(usage.cachedTokens),
    toolCalls: Number.isSafeInteger(usage.toolCalls) ? usage.toolCalls : null,
    retries: Number.isSafeInteger(usage.retries) ? usage.retries : null,
    latencyMs: finiteNumber(usage.latencyMs),
    providerCost: finiteNumber(usage.providerCost)
  };
}

function providerAttempts(result, usage) {
  if (result?.status === "NOT_RUN") return 0;
  if (result?.status === "ERROR" && [
    "fetch-unavailable",
    "request-budget-exhausted",
    "token-budget-exhausted",
    "token-budget-unknown"
  ].includes(result.error?.kind)) return 0;
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
    providerRequestId: typeof result?.providerRequestId === "string" ? result.providerRequestId : null,
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
  if (result?.reason === "VERSION_MISMATCH" && result?.current) safe.current = safeSnapshot(result.current);
  return safe;
}

function safeAction(action, type, expectedVersion) {
  const safe = { type };
  if (action?.kind) safe.kind = action.kind;
  if (typeof action?.value === "string") {
    safe.valueHash = sha(action.value);
    safe.valueBytes = Buffer.byteLength(action.value, "utf8");
  }
  if (typeof expectedVersion === "string") safe.expectedVersion = expectedVersion;
  if (typeof action?.basedOnVersion === "string") safe.basedOnVersion = action.basedOnVersion;
  return safe;
}

function countConflictSnapshotsReused(actions) {
  let reused = 0;
  for (let index = 0; index < actions.length; index += 1) {
    const conflict = actions[index];
    if (conflict.action.type !== "actIfVersion" || conflict.result.reason !== "VERSION_MISMATCH" || !conflict.result.current) continue;
    for (let next = index + 1; next < actions.length; next += 1) {
      const action = actions[next].action;
      if (action.type === "read") break;
      if (action.type === "actIfVersion") {
        if (action.expectedVersion === conflict.result.current.version) reused += 1;
        break;
      }
      if (["act", "reject"].includes(action.type)) break;
    }
  }
  return reused;
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
  const completeUsage = attempted.length > 0 && !retryTelemetryIncomplete && attempted.every((call) => ["inputTokens", "outputTokens", "cachedTokens"].every((key) => finiteNumber(call.usage?.[key]) !== null));
  const tokenMetric = (key) => retryTelemetryIncomplete || attempted.length === 0 ? null : sumKnown(usages.map((usage) => usage?.[key] ?? null));
  return {
    completionRequests: calls.length,
    llmCalls: sumKnown(calls.map((call) => call.providerAttempts)),
    providerAttempts: sumKnown(calls.map((call) => call.providerAttempts)),
    retries: sumKnown(usages.map((usage) => usage?.retries ?? null)),
    inputTokens: tokenMetric("inputTokens"),
    outputTokens: tokenMetric("outputTokens"),
    totalTokens: tokenMetric("totalTokens"),
    cachedTokens: tokenMetric("cachedTokens"),
    latencyMs: attempted.length === 0 ? null : sumKnown(latency),
    providerCost: tokenMetric("providerCost"),
    toolCalls: tokenMetric("toolCalls"),
    usageStatus: attempted.length === 0 ? "NOT_RUN" : completeUsage ? "COMPLETE" : retryTelemetryIncomplete ? "PARTIAL_RETRY_TELEMETRY" : "PARTIAL_OR_UNKNOWN"
  };
}

function traceEvaluation(status, evaluation, actions) {
  if (status !== "OK") return null;
  const casConflict = actions.some(({ action, result }) => action.type === "actIfVersion" && result.reason === "VERSION_MISMATCH");
  const terminalOutcome = evaluation.unsafe
    ? "UNSAFE"
    : evaluation.correct && evaluation.action?.kind === "apply"
      ? "COMPLETED_FRESH"
      : evaluation.correct && evaluation.action?.kind === "reject"
        ? "SAFE_REJECT"
        : casConflict
          ? "CAS_CONFLICT"
          : evaluation.falseBlock
            ? "FALSE_BLOCK"
            : "UNKNOWN";
  return {
    completed: terminalOutcome === "COMPLETED_FRESH",
    unsafeAction: evaluation.unsafe,
    falseBlock: evaluation.falseBlock,
    changed: evaluation.changed,
    recovered: evaluation.recovered,
    toctouEscape: evaluation.toctouEscape,
    actionAttempted: evaluation.action !== null,
    safety: evaluation.unsafe ? "UNSAFE" : "SAFE",
    terminalOutcome
  };
}

async function runAgent({ candidate, task, arm, round, delayMs = 0, maxTurns: turnLimit = maxTurns }) {
  const world = createWorld(task);
  const initial = world.initial;
  if (task.mutationWindow === "before-action") world.mutate();

  const local = { count: 0, states: [], signals: 0 };
  let memory = initial;
  const messages = [{ role: "system", content: systemPrompt(arm) }];
  const start = visibleEnvelope({ task, memory, arm, world, local });
  if (armPolicies[arm].localCheck) local.states.push(start.localCheck.state);
  messages.push({ role: "user", content: JSON.stringify(start) });

  const calls = [];
  const actions = [];
  let protocolErrors = 0;
  let agentStatus = null;
  let terminationReason = null;
  const started = performance.now();

  for (let turn = 0; turn < turnLimit; turn += 1) {
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
      terminationReason = result.reason === "missing-credential" ? "MISSING_CREDENTIAL" : "NOT_RUN";
      break;
    }
    if (result.status === "ERROR") {
      agentStatus = "ERROR";
      terminationReason = result.error?.kind === "request-budget-exhausted"
        ? "REQUEST_BUDGET"
        : result.error?.kind?.startsWith("token-budget")
          ? "TOKEN_BUDGET"
          : "PROVIDER_ERROR";
      break;
    }

    let message;
    try {
      message = parseAgentMessage(result.output, arm);
    } catch {
      protocolErrors += 1;
      terminationReason = "MODEL_PROTOCOL_ERROR";
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
    const safeResult = safeToolResult(tool, resultValue);
    actions.push({
      turn: turn + 1,
      action: safeAction(message.action, message.type, message.expectedVersion),
      result: safeResult
    });
    // A CAS response may expose the conflicting snapshot, but it is not an
    // implicit read. Keep it in the tool result only; a candidate must issue
    // an explicit read before using refreshed state. This preserves both the
    // signal and its operation accounting.
    const accepted = resultValue?.accepted === true;
    if (tool === "reject" || (accepted && ["act", "actIfVersion"].includes(tool))) {
      agentStatus = "OK";
      terminationReason = tool === "reject" ? "REJECTED" : "ACTION_ACCEPTED";
      break;
    }
    const feedback = observationEnvelope({
      world,
      memory,
      arm,
      local,
      tool,
      result: tool === "read" ? resultValue : safeResult
    });
    if (armPolicies[arm].localCheck) local.states.push(feedback.localCheck.state);
    messages.push({ role: "user", content: JSON.stringify(feedback) });
  }

  if (agentStatus === null) {
    agentStatus = "ERROR";
    terminationReason = "TURN_LIMIT";
  }
  const evaluation = world.evaluate();
  const llm = summarizeCalls(calls);
  return {
    taskId: task.taskId,
    arm,
    status: agentStatus,
    providerStatus: providerStatus(calls),
    agentStatus,
    terminationReason,
    taskLatencyMs: Number((performance.now() - started).toFixed(3)),
    localChecks: local.count,
    eventSignals: local.signals,
    localCheckStates: local.states,
    externalReads: actions.filter(({ action }) => action.type === "read").length,
    externalWrites: actions.filter(({ action }) => ["act", "actIfVersion"].includes(action.type)).length,
    sourceRequests: actions.filter(({ action }) => ["read", "act", "actIfVersion"].includes(action.type)).length,
    casConflicts: actions.filter(({ action, result }) => action.type === "actIfVersion" && result.reason === "VERSION_MISMATCH").length,
    conflictSnapshotsReused: countConflictSnapshotsReused(actions),
    localRejects: actions.filter(({ action }) => action.type === "reject").length,
    protocolErrors,
    llm,
    calls,
    actions,
    evaluation: traceEvaluation(agentStatus, evaluation, actions)
  };
}

function campaignStatus(items) {
  if (items.length === 0) return "NOT_RUN";
  if (items.some((item) => item.calls?.some((call) => call.error?.status === 402))) return "PAYMENT_REQUIRED";
  if (items.some((item) => item.calls?.some((call) => call.error?.status === 429))) return "RATE_LIMITED";
  if (items.some((item) => item.calls?.some((call) => call.error?.kind === "request-budget-exhausted"))) return "REQUEST_BUDGET_EXHAUSTED";
  if (items.some((item) => item.calls?.some((call) => ["token-budget-exhausted", "token-budget-exceeded"].includes(call.error?.kind)))) return "TOKEN_BUDGET_EXHAUSTED";
  if (items.some((item) => item.calls?.some((call) => ["token-budget-unknown", "token-budget-unknown-after-call"].includes(call.error?.kind)))) return "TOKEN_BUDGET_UNKNOWN";
  if (items.some((item) => item.status === "ERROR")) return "ERROR";
  if (items.some((item) => item.status === "NOT_RUN")) return "NOT_RUN";
  return "OK";
}

function rate(traces, key, comparable) {
  if (!comparable) return null;
  return (traces.filter((trace) => trace.evaluation?.[key] === true).length * 100) / traces.length;
}

function outcomeCounts(traces, comparable) {
  if (!comparable) return null;
  const counts = Object.fromEntries(["COMPLETED_FRESH", "SAFE_REJECT", "FALSE_BLOCK", "CAS_CONFLICT", "UNSAFE", "UNKNOWN"].map((outcome) => [outcome, 0]));
  for (const trace of traces) {
    const outcome = trace.evaluation?.terminalOutcome ?? "UNKNOWN";
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}

function aggregateArm(arm, traces) {
  const status = campaignStatus(traces);
  const comparable = status === "OK";
  const metric = (key) => sumKnown(traces.map((trace) => trace.llm[key]));
  const latencyValues = traces.map((trace) => trace.llm.latencyMs);
  const taskLatencyValues = traces.map((trace) => trace.taskLatencyMs);
  const completed = comparable ? traces.filter((trace) => trace.evaluation.completed).length : null;
  const unsafeActions = comparable ? traces.filter((trace) => trace.evaluation.unsafeAction).length : null;
  const actionAttempts = comparable ? traces.filter((trace) => trace.evaluation.actionAttempted).length : null;
  const actionAttemptsObserved = comparable
    ? sumKnown(traces.map((trace) => trace.actions.filter(({ action }) => ["act", "actIfVersion", "reject"].includes(action.type)).length))
    : null;
  const safeAttempts = actionAttempts === null ? null : actionAttempts - unsafeActions;
  const successfulFreshActions = comparable
    ? traces.filter((trace) => trace.evaluation.completed && trace.actions.some(({ action, result }) => action.kind === "apply" && result.accepted === true)).length
    : null;
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
    unsafeRateBasis: "final-world-action-per-task",
    falseBlocks: comparable ? traces.filter((trace) => trace.evaluation.falseBlock).length : null,
    falseBlockRate: rate(traces, "falseBlock", comparable),
    outcomeCounts: outcomeCounts(traces, comparable),
    recoveredRate: rate(traces, "recovered", comparable),
    toctouEscapeRate: rate(traces, "toctouEscape", comparable),
    actionAttempts,
    actionAttemptsObserved,
    safeAttempts,
    safeSuccessfulTasks: successfulFreshActions,
    completionRequests: metric("completionRequests"),
    llmCalls: metric("llmCalls"),
    providerAttempts: metric("providerAttempts"),
    retries: metric("retries"),
    inputTokens: metric("inputTokens"),
    outputTokens: metric("outputTokens"),
    totalTokens: metric("totalTokens"),
    cachedTokens: metric("cachedTokens"),
    latencyMs: metric("latencyMs"),
    latencyP50Ms: percentile(latencyValues, 0.5),
    latencyP95Ms: percentile(latencyValues, 0.95),
    taskLatencyMs: sumKnown(taskLatencyValues),
    taskLatencyP50Ms: percentile(taskLatencyValues, 0.5),
    taskLatencyP95Ms: percentile(taskLatencyValues, 0.95),
    providerCost,
    providerCostPerSafeAttempt: providerCost === null || safeAttempts === null || safeAttempts === 0 ? null : providerCost / safeAttempts,
    providerCsfa: providerCost === null || successfulFreshActions === null || successfulFreshActions === 0 ? null : providerCost / successfulFreshActions,
    totalCsfa: null,
    totalCostStatus: "UNKNOWN_CONNECTOR_AND_COMPUTE_COST",
    wastedTasks: completed === null ? null : traces.length - completed,
    wastedWorkRate: completed === null ? null : (traces.length - completed) / traces.length,
    tokensPerSafeSuccessfulTask: successfulFreshActions === null || successfulFreshActions === 0 || metric("inputTokens") === null || metric("outputTokens") === null
      ? null
      : (metric("inputTokens") + metric("outputTokens")) / successfulFreshActions,
    toolCalls: metric("toolCalls"),
    usageStatus: usageStatuses.size === 1 ? [...usageStatuses][0] : "MIXED",
    localChecks: sumKnown(traces.map((trace) => trace.localChecks)),
    eventSignals: sumKnown(traces.map((trace) => trace.eventSignals)),
    externalReads: sumKnown(traces.map((trace) => trace.externalReads)),
    externalWrites: sumKnown(traces.map((trace) => trace.externalWrites)),
    sourceRequests: sumKnown(traces.map((trace) => trace.sourceRequests)),
    casConflicts: sumKnown(traces.map((trace) => trace.casConflicts)),
    conflictSnapshotsReused: sumKnown(traces.map((trace) => trace.conflictSnapshotsReused)),
    localRejects: sumKnown(traces.map((trace) => trace.localRejects)),
    protocolErrors: sumKnown(traces.map((trace) => trace.protocolErrors)),
    statusCounts: Object.fromEntries(["OK", "NOT_RUN", "ERROR"].map((value) => [value, traces.filter((trace) => trace.status === value).length]))
  };
}

function armResults(arms, traces) {
  return arms.map((arm) => aggregateArm(arm, traces.filter((trace) => trace.arm === arm)));
}

function makeBlindIds(arms) {
  const ids = new Map();
  const used = new Set();
  for (const arm of arms) {
    let id;
    do id = `candidate-${randomBytes(18).toString("hex")}`; while (used.has(id));
    used.add(id);
    ids.set(arm, id);
  }
  return ids;
}

function decimal(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function pricingFields(value) {
  if (!recordObject(value)) return null;
  const fields = ["prompt", "completion", "request", "input_cache_read", "input_cache_write"];
  const pricing = {};
  for (const field of fields) {
    const parsed = decimal(value[field]);
    if (parsed !== null) pricing[field] = parsed;
  }
  return Object.keys(pricing).length > 0 ? pricing : null;
}

async function fetchOpenRouterPricing(args) {
  if (args.provider !== "openrouter") return { status: "NOT_APPLICABLE", source: null, pricing: null };
  const modelPath = args.model.split("/").map((part) => encodeURIComponent(part)).join("/");
  const endpoint = `https://openrouter.ai/api/v1/model/${modelPath}`;
  try {
    const response = await fetch(endpoint, { headers: { accept: "application/json" } });
    if (!response.ok) return { status: "UNKNOWN", source: endpoint, httpStatus: response.status, pricing: null };
    const body = await response.json();
    const pricing = pricingFields(body?.data?.pricing);
    return {
      status: pricing === null ? "UNKNOWN" : "OK",
      source: endpoint,
      modelId: typeof body?.data?.id === "string" ? body.data.id : args.model,
      pricing,
      unit: "USD per token/request/unit",
      pricingHash: pricing === null ? null : sha({ source: endpoint, model: args.model, pricing }),
      fetchedAt: new Date().toISOString()
    };
  } catch (error) {
    return { status: "UNKNOWN", source: endpoint, reason: error?.name === "AbortError" ? "timeout" : "network", pricing: null };
  }
}

function fetchZaiPricing(args) {
  if (args.provider !== "zai") return { status: "NOT_APPLICABLE", source: null, pricing: null };
  if (args.model !== "glm-4.7-flash") {
    return {
      status: "UNKNOWN",
      source: "https://docs.z.ai/guides/overview/pricing",
      pricing: null,
      reason: "model-not-in-frozen-free-sheet"
    };
  }
  return {
    status: "OK",
    source: "https://docs.z.ai/guides/overview/pricing",
    modelId: args.model,
    pricing: { prompt: 0, completion: 0, request: 0, input_cache_read: 0 },
    unit: "USD per token/request/unit",
    priceBasis: "published-list-price; not a billing receipt",
    snapshot: "official-pricing-page-free-tier",
    pricingHash: sha({ source: "https://docs.z.ai/guides/overview/pricing", model: args.model, pricing: { prompt: 0, completion: 0, request: 0, input_cache_read: 0 } }),
    fetchedAt: new Date().toISOString()
  };
}

async function fetchPricing(args) {
  if (args.provider === "openrouter") return fetchOpenRouterPricing(args);
  return fetchZaiPricing(args);
}

function listedCost(metrics, pricingSnapshot) {
  const pricing = pricingSnapshot?.pricing;
  if (pricingSnapshot?.status !== "OK" || !pricing) return null;
  if (!["inputTokens", "outputTokens", "completionRequests"].every((key) => finiteNumber(metrics[key]) !== null)) return null;
  if (metrics.usageStatus !== "COMPLETE") return null;
  const prompt = decimal(pricing.prompt);
  const completion = decimal(pricing.completion);
  const request = decimal(pricing.request ?? 0);
  if (prompt === null || completion === null || request === null) return null;
  const cached = finiteNumber(metrics.cachedTokens);
  if (cached !== null && cached > 0 && decimal(pricing.input_cache_read) === null) return null;
  const uncachedInput = Math.max(0, metrics.inputTokens - (cached ?? 0));
  const cachedInput = cached ?? 0;
  const cachedRate = cachedInput > 0 ? decimal(pricing.input_cache_read) : 0;
  if (cachedRate === null) return null;
  return Number((uncachedInput * prompt + cachedInput * cachedRate + metrics.outputTokens * completion + metrics.completionRequests * request).toFixed(12));
}

function attachListedPricing(results, pricingSnapshot) {
  return results.map((result) => {
    const cost = listedCost(result, pricingSnapshot);
    return {
      ...result,
      listedCost: cost,
      listedCostPerSafeAttempt: cost === null || result.safeAttempts === null || result.safeAttempts === 0 ? null : cost / result.safeAttempts,
      listedCsfa: cost === null || result.safeSuccessfulTasks === null || result.safeSuccessfulTasks === 0 ? null : cost / result.safeSuccessfulTasks
    };
  });
}

function hasExecutedLlmTask(trace) {
  return trace.calls.some((call) => call.status === "OK");
}

function taskArmOrder(args, taskId) {
  return [...args.arms].sort((left, right) => {
    const leftRank = sha(`${args.seed}:${taskId}:${left}`);
    const rightRank = sha(`${args.seed}:${taskId}:${right}`);
    return leftRank.localeCompare(rightRank) || left.localeCompare(right);
  });
}

function publicTrace(trace) {
  return {
    taskId: trace.taskId,
    localChecks: trace.localChecks,
    eventSignals: trace.eventSignals,
    externalReads: trace.externalReads,
    externalWrites: trace.externalWrites,
    sourceRequests: trace.sourceRequests,
    casConflicts: trace.casConflicts,
    conflictSnapshotsReused: trace.conflictSnapshotsReused,
    protocolErrors: trace.protocolErrors,
    taskLatencyMs: trace.taskLatencyMs,
    terminationReason: trace.terminationReason,
    safety: trace.evaluation?.safety ?? null,
    terminalOutcome: trace.evaluation?.terminalOutcome ?? null,
    providerCalls: trace.calls.length,
    completedCalls: trace.calls.filter((call) => call.status === "OK").length,
    actionCount: trace.actions.length
  };
}

function blindReport(args, results, taskHash, blindIds = makeBlindIds(results.map((result) => result.arm)), plannedTasks = args.tasks) {
  const expectedArms = [...args.arms];
  const actualArms = results.map((result) => result.arm);
  const comparable = expectedArms.length > 0
    && results.length === expectedArms.length
    && new Set(actualArms).size === expectedArms.length
    && expectedArms.every((arm) => actualArms.includes(arm))
    && results.every((result) => result.status === "OK" && result.tasks === plannedTasks && result.protocolErrors === 0);
  if (!comparable) {
    return {
      format: "premisebench-agent/llm-blind/v1",
      status: "NOT_COMPARABLE",
      reason: "candidate coverage is incomplete or at least one arm has provider ERROR/NOT_RUN; no partial ranking is emitted",
      taskCount: plannedTasks,
      taskSetHash: taskHash,
      results: []
    };
  }
  return {
    format: "premisebench-agent/llm-blind/v1",
    status: "READY_FOR_EXAMINER",
    taskCount: plannedTasks,
    taskSetHash: taskHash,
    results: results.map((result) => {
      const attempts = result.actionAttempts;
      const safeAttempts = attempts === null ? null : attempts - result.unsafeActions;
      const metrics = {
        tasks: result.tasks,
        safeCompletionRate: result.completedRate / 100,
        unsafeActionRate: result.unsafeRate / 100,
        attempts,
        actionAttemptsObserved: result.actionAttemptsObserved,
        safeAttempts,
        safeSuccessfulTasks: result.safeSuccessfulTasks,
        unsafeActions: result.unsafeActions,
        unsafeRateBasis: result.unsafeRateBasis,
        falseBlocks: result.falseBlocks,
        outcomeCounts: result.outcomeCounts,
        modelTurns: result.completionRequests,
        connectorRequests: result.sourceRequests,
        providerAttempts: result.providerAttempts,
        externalReads: result.externalReads,
        externalWrites: result.externalWrites,
        sourceRequests: result.sourceRequests,
        casConflicts: result.casConflicts,
        conflictSnapshotsReused: result.conflictSnapshotsReused,
        localChecks: result.localChecks,
        eventSignals: result.eventSignals,
        protocolErrors: result.protocolErrors
      };
      if (result.providerCost !== null) {
        metrics.providerCostUsd = result.providerCost;
        metrics.costPerSafeAttemptUsd = safeAttempts > 0 ? result.providerCost / safeAttempts : null;
        metrics.costPerSafeSuccessfulTaskUsd = result.safeSuccessfulTasks > 0 ? result.providerCost / result.safeSuccessfulTasks : null;
        metrics.csfaUsd = result.safeSuccessfulTasks > 0 ? result.providerCost / result.safeSuccessfulTasks : null;
      }
      if (finiteNumber(result.listedCost) !== null) {
        metrics.listedCostUsd = result.listedCost;
        metrics.listedCostPerSafeAttemptUsd = result.listedCostPerSafeAttempt;
        metrics.listedCsfaUsd = result.listedCsfa;
      }
      return { id: blindIds.get(result.arm), metrics };
    })
  };
}

function fixed(value, digits = 2) {
  return finiteNumber(value) === null ? "UNKNOWN" : value.toFixed(digits);
}

function reportMarkdown({ args, manifest, summary }) {
  const rows = summary.results.map((result) => {
    const metrics = result.metrics;
    return `| ${result.arm} | ${result.status} | ${fixed(metrics.completedRate, 1)}% | ${fixed(metrics.unsafeRate, 1)}% | ${fixed(metrics.completionRequests, 0)} | ${fixed(metrics.sourceRequests, 0)} | ${fixed(metrics.externalReads, 0)} | ${fixed(metrics.inputTokens, 0)} | ${fixed(metrics.outputTokens, 0)} | ${fixed(metrics.totalTokens, 0)} | ${fixed(metrics.retries, 0)} | ${fixed(metrics.taskLatencyP50Ms)} | ${metrics.providerCost === null ? "UNKNOWN" : `$${fixed(metrics.providerCost, 6)}`} | ${metrics.listedCost === null ? "UNKNOWN" : `$${fixed(metrics.listedCost, 8)}`} | ${metrics.listedCsfa === null ? "UNKNOWN" : `$${fixed(metrics.listedCsfa, 8)}`} |`;
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
    "| Arm | Status | Completed / 100 | Unsafe tasks / 100 | Model turns | Source requests | Reads | Input tokens | Output tokens | Total tokens | Retries | Task p50 ms | providerCost | Listed cost | Listed CSFA |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "`Unsafe tasks / 100` is deliberately task-level: the local world retains one final action for evaluation. `actionAttemptsObserved` counts every action emitted by the agent and `unsafeRateBasis` is recorded in `summary.json`; this report does not pretend that intermediate overwritten actions have a reliable per-action safety label. `Model turns` counts completion requests; `Source requests` counts synthetic reads and writes, while provider attempts and retries remain in `summary.json`. `UNKNOWN`/`null` means the provider did not supply a reliable measurement or the arm was not comparable. It is never a zero-filled estimate. `providerCost` is reported only when returned by the provider response. Listed cost is calculated from the provider's frozen published price snapshot only when usage is complete; it is not a billing receipt. Total agent cost remains UNKNOWN until connector and compute costs are instrumented.",
    "",
    "## Boundary and reproducibility",
    "",
    `- Task-set hash: \`${manifest.taskSetHash}\`; private mutation schedule commitment: \`${manifest.privateScheduleHash}\`. The agent input contains only task prompt/source, declared action risk when present, initial or freshly read memory, tool results, and the assigned freshness/event signal.`,
    "- The mutation schedule, evaluator fields, target result, and labels stay outside the agent messages; traces store hashes and safe telemetry rather than raw model output.",
    `- Artifacts contain no credential values. The configured credential environment name is \`${manifest.credentialEnv}\` only.`,
    `- The ${args.maxTurns}-turn cap, sequential execution, JSON parser, single local world, ${args.delayMs}ms post-call delay, ${args.minRequestIntervalMs}ms minimum request interval, ${args.maxProviderRequests || "unbounded"} provider-request budget and ${args.maxProviderTokens || "unbounded"} provider-token budget limit this pilot; repeat across providers, seeds, and an external holdout before making a comparative claim.`,
    `- Blind examiner status: **${manifest.blindExaminerStatus}**. A partial provider campaign is never ranked.`,
    "",
    "## Artifacts",
    "",
    "`manifest.json`, `summary.json`, `traces.jsonl`, and this `report.md` are written under `.tmp/scientific-mvp/llm/<round>/`."
  ].join("\n");
}

function publicManifest(args, candidate, tasks, status, hash, pricing) {
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
    pricing,
    providerBudget: candidate.requestStats(),
    round: args.round,
    seed: args.seed,
    scenario: args.scenario,
    volatility: args.scenario === "hard" ? args.volatility : null,
    riskLevels: args.scenario === "hard" ? args.riskLevels : null,
    taskCount: tasks.length,
    arms: args.arms,
    armTools: Object.fromEntries(args.arms.map((arm) => [arm, armPolicies[arm].tools])),
    taskSetHash: hash,
    privateScheduleHash: privateScheduleHash(tasks),
    mutationWorld: args.scenario === "hard" ? "private:createWorld(hard-task)" : "private:createWorld(task)",
    mutationSchedule: "private",
    labels: "withheld-from-agent",
    agentProtocol: protocol,
    toolSchemaHash: sha(toolSchema),
    systemPromptHashes: Object.fromEntries(args.arms.map((arm) => [arm, sha(systemPrompt(arm))])),
    taskPromptHashes: Object.fromEntries(tasks.map((task) => [task.taskId, sha(task.prompt)])),
    responseTypes: ["read", "act", "actIfVersion", "reject"],
    agentInputExcludes: ["mutation", "expected", "oracle", "labels", "family", "outcome", "groundTruth", "hardCase", "volatility", "domain", "events", "evaluator"],
    localCheckArms: args.arms.filter((arm) => armPolicies[arm].localCheck),
    eventSignalArms: args.arms.filter((arm) => armPolicies[arm].eventSignal),
    maxTurns: args.maxTurns,
    maxRetries: args.maxRetries,
    retryDelayMs: args.retryDelayMs,
    delayMs: args.delayMs,
    minRequestIntervalMs: args.minRequestIntervalMs,
    maxProviderRequests: args.maxProviderRequests,
    maxProviderTokens: args.maxProviderTokens,
    usagePolicy: {
      providerTokens: "provider response usage only; missing values remain null",
      providerCost: "provider response cost only; listed price estimate is separate and explicitly labelled",
      retries: "included in providerAttempts and reported separately",
      latency: "candidate-reported per completion, summed without filling NOT_RUN as zero"
    },
    artifacts: ["manifest.json", "summary.json", "traces.jsonl", "traces.evaluator.jsonl (evaluator-only)", "report.md", "blind-report.json", "examined-report.json", "mapping.private.json (evaluator-only)"],
    blindExaminerStatus: status === "OK" ? "READY_FOR_EXAMINER" : "NOT_COMPARABLE",
    generatedAt: new Date().toISOString(),
    // Keep the agent-visible task material in memory only. Artifacts expose
    // hashes so a future run can be matched without publishing prompts or
    // source payloads that may contain private data.
    tasks: tasks.map((task) => ({
      taskId: task.taskId,
      promptHash: sha(task.prompt),
      sourceHash: sha(task.source),
      memoryVersion: sha(task.initial)
    }))
  };
}

async function writeArtifacts({ args, candidate, tasks, traces, summary, blind, examined, blindIds, pricing }) {
  const hash = taskSetHash(tasks);
  const manifest = publicManifest(args, candidate, tasks, summary.status, hash, pricing);
  const directory = resolve(args.outputRoot, args.round);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "traces.jsonl"), `${traces.map((trace) => JSON.stringify(publicTrace(trace))).join("\n")}\n`, "utf8");
  await writeFile(resolve(directory, "traces.evaluator.jsonl"), `${traces.map((trace) => JSON.stringify(trace)).join("\n")}\n`, "utf8");
  await writeFile(resolve(directory, "blind-report.json"), `${JSON.stringify(blind, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "examined-report.json"), `${JSON.stringify(examined, null, 2)}\n`, "utf8");
  await writeFile(resolve(directory, "mapping.private.json"), `${JSON.stringify(Object.fromEntries([...blindIds.entries()].map(([arm, id]) => [id, arm])), null, 2)}\n`, "utf8");
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
      plannedTasks: args.tasks,
      executedLLMTasks: 0,
      seed: args.seed,
      scenario: args.scenario,
      volatility: args.volatility,
      riskLevels: args.riskLevels,
      round: args.round,
      arms: args.arms,
      outputRoot: args.outputRoot,
      maxRetries: args.maxRetries,
      delayMs: args.delayMs,
      maxTurns: args.maxTurns,
      minRequestIntervalMs: args.minRequestIntervalMs,
      maxProviderRequests: args.maxProviderRequests,
      maxProviderTokens: args.maxProviderTokens
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const tasks = args.scenario === "hard"
    ? makeHardTasks(args.tasks, args.seed, { volatility: args.volatility, riskLevels: args.riskLevels })
    : makeTasks(args.tasks, args.seed);
  const plannedTasks = tasks.length;
  const executedTaskIds = new Set();
  const traces = [];
  let stopReason = null;
  outer: for (const task of tasks) {
    for (const arm of taskArmOrder(args, task.taskId)) {
      const trace = await runAgent({ candidate, task, arm, round: args.round, delayMs: args.delayMs, maxTurns: args.maxTurns });
      traces.push(trace);
      if (hasExecutedLlmTask(trace)) executedTaskIds.add(task.taskId);
      const paymentRequired = trace.calls.some((call) => call.error?.status === 402);
      const rateLimited = trace.calls.some((call) => call.error?.status === 429);
      const requestBudgetExhausted = trace.calls.some((call) => call.error?.kind === "request-budget-exhausted");
      const tokenBudgetError = trace.calls.some((call) => ["token-budget-exhausted", "token-budget-exceeded"].includes(call.error?.kind));
      const tokenBudgetUnknown = trace.calls.some((call) => ["token-budget-unknown", "token-budget-unknown-after-call"].includes(call.error?.kind));
      if (paymentRequired || rateLimited || requestBudgetExhausted || tokenBudgetError || tokenBudgetUnknown) {
        stopReason = paymentRequired
          ? "PAYMENT_REQUIRED"
          : rateLimited
            ? "RATE_LIMITED"
            : requestBudgetExhausted
              ? "REQUEST_BUDGET_EXHAUSTED"
              : tokenBudgetUnknown
                ? "TOKEN_BUDGET_UNKNOWN"
                : "TOKEN_BUDGET_EXHAUSTED";
        break outer;
      }
    }
  }
  const executedLLMTasks = executedTaskIds.size;
  const pricing = await fetchPricing(args);
  const results = attachListedPricing(armResults(args.arms, traces), pricing);
  const taskHash = taskSetHash(tasks);
  const scheduleHash = privateScheduleHash(tasks);
  const blindIds = makeBlindIds(args.arms);
  const blind = blindReport(args, results, taskHash, blindIds, plannedTasks);
  const artifactDirectory = resolve(args.outputRoot, args.round);
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
    status: stopReason ?? campaignStatus(results),
    provider: candidate.config.provider,
    model: candidate.config.model,
    credentialEnv: candidate.config.credentialEnv,
    pricing,
    providerBudget: candidate.requestStats(),
    round: args.round,
    seed: args.seed,
    taskCount: tasks.length,
    plannedTasks,
    executedLLMTasks,
    taskSetHash: taskHash,
    privateScheduleHash: scheduleHash,
    scenario: args.scenario,
    stopReason,
    volatility: args.scenario === "hard" ? args.volatility : null,
    riskLevels: args.scenario === "hard" ? args.riskLevels : null,
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
  const { manifest, directory } = await writeArtifacts({ args, candidate, tasks, traces, summary, blind, examined, blindIds, pricing });
  const result = { status: summary.status, round: args.round, tasks: plannedTasks, plannedTasks, executedLLMTasks, arms: args.arms, directory, manifest: manifest.artifacts, results };
  console.log(JSON.stringify(result, null, 2));
  if (args.requireLive && summary.status !== "OK") process.exitCode = 1;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

export {
  aggregateArm,
  blindReport,
  listedCost,
  main,
  parseAgentMessage,
  parseArgs,
  runAgent,
  systemPrompt,
  visibleEnvelope
};
