import { readFile } from "node:fs/promises";
import { DEFAULT_ENDPOINTS, normalizeProvider } from "./adapters.mjs";

const DEFAULT_CREDENTIAL_ENV = Object.freeze({
  "openai-compatible": "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
});

const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?key|authorization|bearer|secret|password|credential|private[_-]?key|refresh[_-]?token|token[_-]?value|env(?:ironment)?(?:[_-]?value)?)/i;
const INLINE_CREDENTIAL_KEY = /^(?:api[_-]?key|access[_-]?token|token|secret|password|authorization|credential)$/i;
const REDACTED = "[REDACTED]";
const OPENROUTER_HEADER_ALLOWLIST = new Set(["http-referer", "x-title"]);

export const DEFAULT_CONFIG = Object.freeze({
  temperature: 0,
  maxTokens: 512,
  timeoutMs: 30_000,
  maxRetries: 2,
  responseFormat: null,
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} is required`);
  return value.trim();
}

function optionalString(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function boundedNumber(value, name, { integer = false, min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function httpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("endpoint must be an HTTP(S) URL");
  }
  if (!(["http:", "https:"].includes(url.protocol))) throw new TypeError("endpoint must be an HTTP(S) URL");
  if (url.username || url.password || [...url.searchParams.keys()].some((key) => /(?:key|token|secret|password|authorization)/i.test(key))) {
    throw new TypeError("endpoint must not contain credentials");
  }
  return url.toString();
}

function parseHeaders(value) {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) throw new TypeError("headers must be an object");
  const headers = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(name)) throw new TypeError("credential headers must use credentialEnv");
    if (typeof headerValue !== "string") throw new TypeError("header values must be strings");
    headers[name] = headerValue;
  }
  return Object.freeze(headers);
}

function rejectInlineCredentials(raw) {
  for (const key of Object.keys(raw)) {
    if (INLINE_CREDENTIAL_KEY.test(key)) throw new TypeError("inline credentials are not allowed; use credentialEnv");
  }
}

export function parseConfig(input) {
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new TypeError("LLM config must be valid JSON");
    }
  }
  if (!isRecord(raw)) throw new TypeError("LLM config must be an object");
  rejectInlineCredentials(raw);

  const provider = normalizeProvider(raw.provider);
  if (!provider) throw new TypeError("unsupported LLM provider");
  const requestedProvider = raw.provider.trim().toLowerCase();
  const defaultsProvider = requestedProvider === "openrouter" ? "openrouter" : provider;
  const model = requiredString(raw.model, "model");
  const credentialEnv = requiredString(raw.credentialEnv ?? DEFAULT_CREDENTIAL_ENV[defaultsProvider], "credentialEnv");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialEnv)) throw new TypeError("credentialEnv must be an environment variable name");
  if (provider === "openrouter" && credentialEnv !== "OPENROUTER_API_KEY") throw new TypeError("OpenRouter requires credentialEnv=OPENROUTER_API_KEY");

  const endpoint = httpUrl(raw.endpoint ?? raw.baseUrl ?? DEFAULT_ENDPOINTS[defaultsProvider]);
  if (provider === "openrouter") {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.hostname !== "openrouter.ai" || parsed.port !== "" || parsed.pathname !== "/api/v1/chat/completions" || parsed.search !== "" || parsed.hash !== "") {
      throw new TypeError("OpenRouter endpoint must be https://openrouter.ai/api/v1/chat/completions");
    }
  }
  const prompt = optionalString(raw.prompt, "prompt");
  const systemPrompt = optionalString(raw.systemPrompt, "systemPrompt");
  const headers = parseHeaders(raw.headers);
  if (provider === "openrouter" && Object.keys(headers).some((name) => !OPENROUTER_HEADER_ALLOWLIST.has(name.toLowerCase()))) {
    throw new TypeError("OpenRouter headers are limited to HTTP-Referer and X-Title");
  }
  const config = {
    provider,
    model,
    endpoint,
    credentialEnv,
    prompt,
    systemPrompt,
    temperature: boundedNumber(raw.temperature ?? DEFAULT_CONFIG.temperature, "temperature", { max: 2 }),
    maxTokens: boundedNumber(raw.maxTokens ?? DEFAULT_CONFIG.maxTokens, "maxTokens", { integer: true, min: 1 }),
    timeoutMs: boundedNumber(raw.timeoutMs ?? DEFAULT_CONFIG.timeoutMs, "timeoutMs", { integer: true, min: 1 }),
    maxRetries: boundedNumber(raw.maxRetries ?? DEFAULT_CONFIG.maxRetries, "maxRetries", { integer: true, min: 0, max: 10 }),
    responseFormat: raw.responseFormat ?? raw.response_format ?? DEFAULT_CONFIG.responseFormat,
    headers,
  };
  if (config.responseFormat !== null && config.responseFormat !== "json-object") throw new TypeError("responseFormat must be json-object or null");
  return Object.freeze(config);
}

export async function loadConfig(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") throw new TypeError("config path is required");
  return parseConfig(await readFile(filePath, "utf8"));
}

function redactString(value, secrets) {
  let result = value;
  for (const secret of secrets) result = result.replaceAll(secret, REDACTED);
  return result
    .replace(/(Bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|secret|password)=)[^&\s]+/gi, `$1${REDACTED}`);
}

function redactValue(value, secrets) {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (!isRecord(value)) return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(child, secrets);
  }
  return result;
}

export function redact(value, secrets = []) {
  const knownSecrets = [...new Set(secrets.filter((secret) => typeof secret === "string" && secret !== ""))]
    .sort((left, right) => right.length - left.length);
  return redactValue(value, knownSecrets);
}

export const redactForLog = redact;

export { DEFAULT_CREDENTIAL_ENV };
