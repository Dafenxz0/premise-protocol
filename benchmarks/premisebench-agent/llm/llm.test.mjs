import assert from "node:assert/strict";
import test from "node:test";
import { buildProviderRequest, normalizeProviderResponse } from "./adapters.mjs";
import { createLlmCandidate, hashPrompt, parseConfig, redact } from "./index.mjs";

test("parseConfig accepts declarative JSON and fixes run settings", () => {
  const config = parseConfig(JSON.stringify({
    provider: "openai-compatible",
    model: "local-compatible-model",
    credentialEnv: "TEST_LLM_KEY",
    temperature: 0,
    maxTokens: 256,
    maxRetries: 1,
    responseFormat: "json-object",
  }));

  assert.deepEqual({
    provider: config.provider,
    model: config.model,
    credentialEnv: config.credentialEnv,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    maxRetries: config.maxRetries,
    responseFormat: config.responseFormat,
  }, {
    provider: "openai-compatible",
    model: "local-compatible-model",
    credentialEnv: "TEST_LLM_KEY",
    temperature: 0,
    maxTokens: 256,
    maxRetries: 1,
    responseFormat: "json-object",
  });
  assert.throws(() => parseConfig({ provider: "anthropic", model: "claude", apiKey: "inline-secret" }), /inline credentials/);
});

test("redact removes secret values and sensitive fields without hiding metrics", () => {
  const secret = "sk-local-test-value";
  const safe = redact({
    apiKey: secret,
    authorization: `Bearer ${secret}`,
    env: { TEST_LLM_KEY: secret },
    message: `request used ${secret}`,
    usage: { inputTokens: 12, outputTokens: 4 },
  }, [secret]);

  assert.equal(safe.apiKey, "[REDACTED]");
  assert.equal(safe.authorization, "[REDACTED]");
  assert.equal(safe.env, "[REDACTED]");
  assert.equal(safe.usage.inputTokens, 12);
  assert.equal(JSON.stringify(safe).includes(secret), false);
});

test("missing credential returns NOT_RUN without invoking fetch", async () => {
  let calls = 0;
  const candidate = createLlmCandidate({
    provider: "openai-compatible",
    model: "offline-model",
    credentialEnv: "MISSING_LLM_KEY",
    prompt: "Return one safe action.",
    temperature: 0,
    maxTokens: 64,
  }, {
    env: Object.create(null),
    fetchImpl: async () => {
      calls += 1;
      throw new Error("fetch must not be called");
    },
  });

  const result = await candidate.complete({ taskId: "offline-task" });
  assert.equal(result.status, "NOT_RUN");
  assert.equal(result.reason, "missing-credential");
  assert.equal(result.provider, "openai-compatible");
  assert.equal(result.model, "offline-model");
  assert.match(result.promptHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.temperature, 0);
  assert.equal(result.maxTokens, 64);
  assert.deepEqual(result.usage, {
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    toolCalls: 0,
    retries: 0,
    latencyMs: 0,
    providerCost: null,
  });
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(candidate.config).includes("MISSING_LLM_KEY"), true);
  assert.equal(JSON.stringify(candidate.config).includes("offline-model"), true);
});

test("adapters and usage normalization are pure offline operations", () => {
  const config = parseConfig({ provider: "gemini", model: "gemini-test", credentialEnv: "TEST_LLM_KEY" });
  const request = buildProviderRequest({
    config,
    credential: "not-logged",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
  });
  assert.match(request.url, /gemini-test:generateContent$/);
  assert.equal(JSON.parse(request.init.body).generationConfig.maxOutputTokens, 512);
  assert.equal(request.init.headers["x-goog-api-key"], "not-logged");
  assert.equal(JSON.parse(request.init.body).generationConfig.responseMimeType, undefined);

  const jsonRequest = buildProviderRequest({
    config: parseConfig({ provider: "gemini", model: "gemini-test", credentialEnv: "TEST_LLM_KEY", responseFormat: "json-object" }),
    credential: "not-logged",
    messages: [{ role: "user", content: "hello" }]
  });
  assert.equal(JSON.parse(jsonRequest.init.body).generationConfig.responseMimeType, "application/json");

  const normalized = normalizeProviderResponse("gemini", {
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: "done" }, { functionCall: { name: "read" } }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, cachedContentTokenCount: 2 },
    cost: 0.001,
  });
  assert.equal(normalized.text, "done");
  assert.deepEqual(normalized.metrics, {
    inputTokens: 10,
    outputTokens: 3,
    cachedTokens: 2,
    toolCalls: 1,
    providerCost: 0.001,
  });
  assert.equal(hashPrompt({ messages: [{ role: "user", content: "hello" }], tools: [] }), hashPrompt({ tools: [], messages: [{ content: "hello", role: "user" }] }));
});
