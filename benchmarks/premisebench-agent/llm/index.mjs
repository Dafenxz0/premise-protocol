import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { buildProviderRequest, normalizeProviderResponse } from "./adapters.mjs";
import { DEFAULT_CONFIG, loadConfig, parseConfig, redact, redactForLog } from "./config.mjs";

export const LLM_CONTRACT = "premisebench-llm/1";
export const RESULT_STATUSES = Object.freeze(["OK", "NOT_RUN", "ERROR"]);
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const FIXED_FIELDS = ["provider", "model", "temperature", "maxTokens", "max_tokens", "maxOutputTokens", "max_output_tokens", "responseFormat", "response_format", "promptHash"];

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateMessages(value) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("messages must be a non-empty array");
  return value.map((message) => {
    if (!record(message) || !["system", "user", "assistant", "tool"].includes(message.role)) throw new TypeError("message role is invalid");
    if (typeof message.content !== "string" && !Array.isArray(message.content)) throw new TypeError("message content is invalid");
    return { ...message };
  });
}

function normalizeInput(request, config) {
  if (!record(request)) throw new TypeError("LLM request must be an object");
  for (const field of FIXED_FIELDS) {
    if (Object.hasOwn(request, field)) throw new TypeError(`${field} is fixed by config`);
  }
  if (Object.hasOwn(request, "messages") && (Object.hasOwn(request, "prompt") || Object.hasOwn(request, "input"))) {
    throw new TypeError("use messages or prompt, not both");
  }

  let messages;
  if (Object.hasOwn(request, "messages")) messages = validateMessages(request.messages);
  else {
    const prompt = request.prompt ?? request.input ?? config.prompt;
    if (typeof prompt !== "string") throw new TypeError("prompt or messages is required");
    messages = [{ role: "user", content: prompt }];
  }
  if (config.systemPrompt !== null) messages = [{ role: "system", content: config.systemPrompt }, ...messages];

  const tools = request.tools ?? [];
  if (!Array.isArray(tools) || tools.some((tool) => !record(tool))) throw new TypeError("tools must be an array of objects");
  return { messages, tools };
}

function canonicalize(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("prompt must be JSON-serializable");
    return value;
  }
  if (value === undefined) return null;
  if (typeof value !== "object") throw new TypeError("prompt must be JSON-serializable");
  if (seen.has(value)) throw new TypeError("prompt must be JSON-serializable");
  seen.add(value);
  let normalized;
  if (Array.isArray(value)) normalized = value.map((item) => canonicalize(item, seen));
  else normalized = Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key], seen)]));
  seen.delete(value);
  return normalized;
}

export function hashPrompt(prompt) {
  const canonical = JSON.stringify(canonicalize(prompt));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function elapsedMs(started, now) {
  return Math.round(Math.max(0, now() - started) * 100) / 100;
}

function usage({ inputTokens = null, outputTokens = null, cachedTokens = null, toolCalls = 0, retries = 0, latencyMs = 0, providerCost = null } = {}) {
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    toolCalls,
    retries,
    latencyMs,
    providerCost,
  };
}

function baseResult(config, promptHash, request) {
  return {
    protocol: LLM_CONTRACT,
    type: "result",
    requestId: typeof request.requestId === "string" ? request.requestId : undefined,
    taskId: typeof request.taskId === "string" ? request.taskId : undefined,
    provider: config.provider,
    model: config.model,
    promptHash,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  };
}

function publicConfig(config) {
  return Object.freeze({
    provider: config.provider,
    model: config.model,
    endpoint: redact(config.endpoint),
    credentialEnv: config.credentialEnv,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    responseFormat: config.responseFormat,
    headers: redact(config.headers),
  });
}

function credentialFrom(env, name) {
  const value = env?.[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function timeoutSignal(timeoutMs) {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
}

function safeError(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return { kind: "timeout" };
  if (error instanceof SyntaxError) return { kind: "invalid-response" };
  return { kind: "network" };
}

function noCredentialResult(base) {
  return {
    ...base,
    status: "NOT_RUN",
    reason: "missing-credential",
    output: null,
    usage: usage(),
  };
}

export function createLlmCandidate(rawConfig, { env = process.env, fetchImpl = globalThis.fetch, now = () => performance.now() } = {}) {
  const config = parseConfig(rawConfig);

  async function complete(request = {}) {
    const input = normalizeInput(request, config);
    const promptHash = hashPrompt(input);
    const base = baseResult(config, promptHash, request);
    const credential = credentialFrom(env, config.credentialEnv);
    if (credential === null) return noCredentialResult(base);
    if (typeof fetchImpl !== "function") {
      return {
        ...base,
        status: "ERROR",
        error: { kind: "fetch-unavailable" },
        usage: usage(),
      };
    }

    const providerRequest = buildProviderRequest({ ...input, config, credential });
    const started = now();
    let retries = 0;
    while (true) {
      try {
        const signal = timeoutSignal(config.timeoutMs);
        const response = await fetchImpl(providerRequest.url, {
          ...providerRequest.init,
          redirect: "error",
          ...(signal ? { signal } : {}),
        });
        if (response.ok) {
          const parsed = normalizeProviderResponse(config.provider, await response.json());
          return {
            ...base,
            status: "OK",
            output: parsed.text,
            finishReason: parsed.finishReason,
            usage: usage({ ...parsed.metrics, retries, latencyMs: elapsedMs(started, now) }),
          };
        }
        if (RETRYABLE_STATUS.has(response.status) && retries < config.maxRetries) {
          retries += 1;
          continue;
        }
        return {
          ...base,
          status: "ERROR",
          error: { kind: "http", status: response.status },
          usage: usage({ retries, latencyMs: elapsedMs(started, now) }),
        };
      } catch (error) {
        const safe = safeError(error);
        if ((safe.kind === "network" || safe.kind === "timeout") && retries < config.maxRetries) {
          retries += 1;
          continue;
        }
        return {
          ...base,
          status: "ERROR",
          error: safe,
          usage: usage({ retries, latencyMs: elapsedMs(started, now) }),
        };
      }
    }
  }

  return Object.freeze({
    contract: LLM_CONTRACT,
    config: publicConfig(config),
    complete,
  });
}

export { DEFAULT_CONFIG, loadConfig, parseConfig, redact, redactForLog };
