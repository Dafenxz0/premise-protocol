export const DEFAULT_ENDPOINTS = Object.freeze({
  "openai-compatible": "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
});

export function normalizeProvider(value) {
  if (typeof value !== "string") return null;
  const provider = value.trim().toLowerCase();
  if (["openai", "openai-compatible", "openai_compatible", "chat-completions"].includes(provider)) return "openai-compatible";
  if (provider === "anthropic") return "anthropic";
  if (["gemini", "google", "google-gemini"].includes(provider)) return "gemini";
  return null;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function textParts(content) {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (typeof part === "string") return [{ text: part }];
    if (!part || typeof part !== "object") return [];
    if (typeof part.text === "string") return [{ text: part.text }];
    if (part.type === "tool_use" || part.type === "functionCall" || part.type === "function_call") {
      return [{ functionCall: part.function ?? { name: part.name, args: part.input ?? part.arguments ?? {} } }];
    }
    if (part.type === "tool_result" || part.type === "functionResponse" || part.type === "function_response") {
      return [{ functionResponse: { name: part.name ?? part.tool_name, response: part.content ?? part.output ?? {} } }];
    }
    return [];
  });
}

function anthropicTool(tool) {
  const source = object(tool.function ?? tool);
  return {
    name: source.name,
    ...(source.description ? { description: source.description } : {}),
    input_schema: source.input_schema ?? source.parameters ?? {},
  };
}

function geminiTool(tool) {
  const source = object(tool.function ?? tool);
  return {
    name: source.name,
    ...(source.description ? { description: source.description } : {}),
    parameters: source.parameters ?? source.input_schema ?? {},
  };
}

function anthropicMessages(messages) {
  let system = [];
  const result = [];
  for (const message of messages) {
    if (message.role === "system") {
      system.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
      continue;
    }
    if (message.role === "tool") {
      result.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content }],
      });
      continue;
    }
    result.push({ role: message.role === "assistant" ? "assistant" : "user", content: message.content });
  }
  return { system: system.join("\n\n"), messages: result };
}

function geminiContents(messages) {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: message.role === "tool"
        ? [{ functionResponse: { name: message.name ?? message.tool_name, response: message.content } }]
        : textParts(message.content),
    }));
}

function geminiSystemInstruction(messages) {
  const system = messages.filter((message) => message.role === "system");
  if (system.length === 0) return undefined;
  return { parts: system.flatMap((message) => textParts(message.content)) };
}

function geminiUrl(config) {
  const endpoint = config.endpoint.replace(/\/$/, "");
  if (endpoint.endsWith(":generateContent")) return endpoint;
  const model = encodeURIComponent(config.model.replace(/^models\//, ""));
  return `${endpoint}/models/${model}:generateContent`;
}

function headers(extra, auth) {
  return { ...extra, "content-type": "application/json", ...auth };
}

export function buildProviderRequest({ config, credential, messages, tools = [] }) {
  if (config.provider === "openai-compatible") {
    const body = {
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream: false,
    };
    if (config.responseFormat === "json-object") body.response_format = { type: "json_object" };
    if (tools.length > 0) body.tools = tools;
    return {
      url: config.endpoint,
      init: {
        method: "POST",
        headers: headers(config.headers, { authorization: `Bearer ${credential}` }),
        body: JSON.stringify(body),
      },
    };
  }

  if (config.provider === "anthropic") {
    const converted = anthropicMessages(messages);
    const body = {
      model: config.model,
      messages: converted.messages,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
    };
    if (converted.system) body.system = converted.system;
    if (tools.length > 0) body.tools = tools.map(anthropicTool);
    return {
      url: config.endpoint,
      init: {
        method: "POST",
        headers: headers(config.headers, {
          "x-api-key": credential,
          "anthropic-version": "2023-06-01",
        }),
        body: JSON.stringify(body),
      },
    };
  }

  if (config.provider === "gemini") {
    const body = {
      contents: geminiContents(messages),
      generationConfig: {
        temperature: config.temperature,
        maxOutputTokens: config.maxTokens,
      },
    };
    if (config.responseFormat === "json-object") body.generationConfig.responseMimeType = "application/json";
    const systemInstruction = geminiSystemInstruction(messages);
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (tools.length > 0) body.tools = [{ functionDeclarations: tools.map(geminiTool) }];
    return {
      url: geminiUrl(config),
      init: {
        method: "POST",
        headers: headers(config.headers, { "x-goog-api-key": credential }),
        body: JSON.stringify(body),
      },
    };
  }

  throw new TypeError("unsupported LLM provider");
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstNumber(...values) {
  return values.map(numberOrNull).find((value) => value !== null) ?? null;
}

function sumNumbers(...values) {
  const numbers = values.map(numberOrNull).filter((value) => value !== null);
  return numbers.length === 0 ? null : numbers.reduce((total, value) => total + value, 0);
}

function providerCost(...values) {
  for (const value of values) {
    const direct = numberOrNull(value);
    if (direct !== null) return direct;
    if (value && typeof value === "object") {
      const nested = firstNumber(value.amount, value.value, value.usd, value.cost, value.total);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function outputText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (part && typeof part.text === "string") return [part.text];
    return [];
  }).join("");
}

function commonMetrics({ inputTokens = null, outputTokens = null, cachedTokens = null, toolCalls = 0, providerCost: cost = null }) {
  return {
    inputTokens: numberOrNull(inputTokens),
    outputTokens: numberOrNull(outputTokens),
    cachedTokens: numberOrNull(cachedTokens),
    toolCalls: Number.isSafeInteger(toolCalls) && toolCalls >= 0 ? toolCalls : 0,
    providerCost: numberOrNull(cost),
  };
}

export function normalizeProviderResponse(provider, body) {
  if (provider === "openai-compatible") {
    const choice = object(body?.choices?.[0]);
    const message = object(choice.message);
    const usage = object(body?.usage);
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.length : message.function_call ? 1 : 0;
    return {
      text: outputText(message.content),
      finishReason: choice.finish_reason ?? null,
      metrics: commonMetrics({
        inputTokens: firstNumber(usage.prompt_tokens, usage.input_tokens),
        outputTokens: firstNumber(usage.completion_tokens, usage.output_tokens),
        cachedTokens: firstNumber(usage.prompt_tokens_details?.cached_tokens, usage.input_tokens_details?.cached_tokens, usage.input_cached_tokens, usage.cached_tokens),
        toolCalls,
        providerCost: providerCost(body?.providerCost, body?.provider_cost, body?.cost, usage.cost, usage.total_cost, usage.cost_usd),
      }),
    };
  }

  if (provider === "anthropic") {
    const content = Array.isArray(body?.content) ? body.content : [];
    const usage = object(body?.usage);
    return {
      text: outputText(content),
      finishReason: body?.stop_reason ?? null,
      metrics: commonMetrics({
        inputTokens: firstNumber(usage.input_tokens, usage.prompt_tokens),
        outputTokens: firstNumber(usage.output_tokens, usage.completion_tokens),
        cachedTokens: sumNumbers(usage.cache_read_input_tokens, usage.cache_creation_input_tokens, usage.cached_tokens),
        toolCalls: content.filter((part) => part?.type === "tool_use").length,
        providerCost: providerCost(body?.providerCost, body?.provider_cost, body?.cost, usage.cost, usage.total_cost, usage.cost_usd),
      }),
    };
  }

  if (provider === "gemini") {
    const candidate = object(body?.candidates?.[0]);
    const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
    const usage = object(body?.usageMetadata ?? body?.usage_metadata ?? body?.usage);
    return {
      text: outputText(parts),
      finishReason: candidate.finishReason ?? null,
      metrics: commonMetrics({
        inputTokens: firstNumber(usage.promptTokenCount, usage.totalInputTokens, usage.input_tokens),
        outputTokens: firstNumber(usage.candidatesTokenCount, usage.totalOutputTokens, usage.output_tokens),
        cachedTokens: firstNumber(usage.cachedContentTokenCount, usage.totalCachedTokens, usage.cached_tokens),
        toolCalls: parts.filter((part) => part?.functionCall || part?.function_call || part?.toolCall).length,
        providerCost: providerCost(body?.providerCost, body?.provider_cost, body?.cost, usage.cost, usage.total_cost, usage.cost_usd),
      }),
    };
  }

  throw new TypeError("unsupported LLM provider");
}
