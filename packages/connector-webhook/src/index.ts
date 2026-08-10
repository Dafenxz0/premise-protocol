import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookSecret = string | Uint8Array;
export type WebhookBody = string | Uint8Array;
export type WebhookHeaderValue = string | readonly string[] | undefined;
export type WebhookHeaders = Headers | Readonly<Record<string, WebhookHeaderValue>>;

export interface WebhookParseOptions {
  readonly secret: WebhookSecret;
  readonly signatureHeader?: string;
  readonly timestampHeader?: string;
  readonly deliveryIdHeader?: string;
  readonly maxBodyBytes?: number;
  readonly maxAgeMs?: number;
  readonly futureSkewMs?: number;
  readonly replayProtection?: boolean;
  readonly requireDeliveryId?: boolean;
  readonly now?: () => number;
}

export interface ParsedWebhook<T = unknown> {
  readonly payload: T;
  readonly rawBody: string;
  readonly signature: string;
  readonly timestamp?: string;
  readonly deliveryId?: string;
}

export interface WebhookDeliveryRecord {
  readonly key: string;
  readonly receivedAt: number;
  readonly deliveryId?: string;
  readonly signature: string;
}

export interface WebhookDedupStore {
  claim(key: string, record: WebhookDeliveryRecord): Promise<boolean> | boolean;
  release?(key: string): Promise<void> | void;
}

export interface WebhookConnectorOptions extends Omit<WebhookParseOptions, "secret"> {
  readonly secret: WebhookSecret;
  readonly dedupStore?: WebhookDedupStore;
  readonly fetch?: typeof fetch;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

export interface WebhookDeliveryRequest {
  readonly url: string;
  readonly payload: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly deliveryId?: string;
  readonly timestamp?: number | string;
  readonly signal?: AbortSignal;
}

export interface WebhookDeliveryResult {
  readonly response: Response;
  readonly attempts: number;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_FUTURE_SKEW_MS = 30 * 1000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 5000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 8;

export class WebhookError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WebhookError";
    this.code = code;
  }
}

export class WebhookSignatureError extends WebhookError {
  constructor() {
    super("WEBHOOK_SIGNATURE_INVALID", "Webhook signature is invalid");
    this.name = "WebhookSignatureError";
  }
}

export class WebhookReplayError extends WebhookError {
  constructor(message = "Webhook timestamp is outside the replay window") {
    super("WEBHOOK_REPLAY_REJECTED", message);
    this.name = "WebhookReplayError";
  }
}

export class WebhookParseError extends WebhookError {
  constructor(message = "Webhook body is not valid JSON") {
    super("WEBHOOK_PARSE_INVALID", message);
    this.name = "WebhookParseError";
  }
}

export class WebhookDeliveryError extends WebhookError {
  readonly status?: number;
  readonly attempts: number;

  constructor(message: string, attempts: number, status?: number, cause?: unknown) {
    super("WEBHOOK_DELIVERY_FAILED", message);
    this.name = "WebhookDeliveryError";
    if (status !== undefined) this.status = status;
    this.attempts = attempts;
    if (cause !== undefined) this.cause = cause;
  }
}

export class MemoryWebhookDedupStore implements WebhookDedupStore {
  private readonly entries = new Map<string, WebhookDeliveryRecord>();
  private readonly maxEntries: number;

  constructor(maxEntries = 10_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError("maxEntries must be a positive integer");
    this.maxEntries = maxEntries;
  }

  claim(key: string, record: WebhookDeliveryRecord): boolean {
    if (this.entries.has(key)) return false;
    this.entries.set(key, record);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
    return true;
  }

  release(key: string): void {
    this.entries.delete(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }
}

function bytes(body: WebhookBody): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

function bodyText(body: WebhookBody): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes(body));
  } catch {
    throw new WebhookParseError("Webhook body is not valid UTF-8");
  }
}

function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    const selected = Array.isArray(value) ? value[0] : value;
    return selected === undefined ? undefined : selected;
  }
  return undefined;
}

function secretBytes(secret: WebhookSecret): WebhookSecret {
  if ((typeof secret !== "string" && !(secret instanceof Uint8Array)) || secret.length === 0) throw new TypeError("Webhook secret must be non-empty");
  return secret;
}

function signatureMessage(body: WebhookBody, timestamp?: string): Uint8Array {
  if (timestamp === undefined) return bytes(body);
  return new TextEncoder().encode(`${timestamp}.${bodyText(body)}`);
}

function digest(body: WebhookBody, secret: WebhookSecret, timestamp?: string): string {
  return createHmac("sha256", secretBytes(secret)).update(signatureMessage(body, timestamp)).digest("hex");
}

function signatureCandidates(signature: string): readonly string[] {
  return signature.split(",").map((part) => part.trim()).filter((part) => /^sha256=[0-9a-f]{64}$/iu.test(part) || /^v[0-9]+=[0-9a-f]{64}$/iu.test(part)).map((part) => part.slice(part.indexOf("=") + 1).toLowerCase());
}

function hexBytes(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
}

function validNumber(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative finite number`);
  return Math.trunc(value);
}

function timestampSeconds(value: string | number | undefined, now: number): string {
  const selected = value === undefined ? Math.floor(now / 1000) : value;
  const text = typeof selected === "number" ? String(Math.trunc(selected)) : selected;
  if (!/^\d+$/.test(text)) throw new TypeError("Webhook timestamp must be Unix seconds");
  const seconds = Number(text);
  if (!Number.isSafeInteger(seconds)) throw new TypeError("Webhook timestamp must be a safe Unix timestamp");
  return text;
}

function assertTimestamp(timestamp: string, now: number, maxAgeMs: number, futureSkewMs: number): void {
  if (!/^\d+$/.test(timestamp)) throw new WebhookReplayError("Webhook timestamp is invalid");
  const milliseconds = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(milliseconds)) throw new WebhookReplayError("Webhook timestamp is invalid");
  if (milliseconds > now + futureSkewMs) throw new WebhookReplayError("Webhook timestamp is in the future");
  if (now - milliseconds > maxAgeMs) throw new WebhookReplayError();
}

export function signWebhookPayload(body: WebhookBody, secret: WebhookSecret, timestamp?: string | number): string {
  const normalizedTimestamp = timestamp === undefined ? undefined : timestampSeconds(timestamp, Date.now());
  return `sha256=${digest(body, secret, normalizedTimestamp)}`;
}

export const signWebhook = signWebhookPayload;

export function verifyWebhookSignature(body: WebhookBody, signature: string | undefined, secret: WebhookSecret | undefined, timestamp?: string | number): boolean {
  if (secret === undefined || signature === undefined) return false;
  let normalizedTimestamp: string | undefined;
  try {
    normalizedTimestamp = timestamp === undefined ? undefined : timestampSeconds(timestamp, Date.now());
    const expected = hexBytes(digest(body, secret, normalizedTimestamp));
    return signatureCandidates(signature).some((candidate) => {
      const actual = hexBytes(candidate);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    });
  } catch {
    return false;
  }
}

function normalizedParseOptions(optionsOrSecret: WebhookParseOptions | WebhookSecret): Required<Pick<WebhookParseOptions, "secret" | "signatureHeader" | "timestampHeader" | "deliveryIdHeader" | "maxBodyBytes" | "maxAgeMs" | "futureSkewMs" | "replayProtection" | "requireDeliveryId" | "now">> {
  const options = typeof optionsOrSecret === "string" || optionsOrSecret instanceof Uint8Array ? { secret: optionsOrSecret } : optionsOrSecret;
  return {
    secret: secretBytes(options.secret),
    signatureHeader: options.signatureHeader ?? "x-webhook-signature",
    timestampHeader: options.timestampHeader ?? "x-webhook-timestamp",
    deliveryIdHeader: options.deliveryIdHeader ?? "x-webhook-id",
    maxBodyBytes: validNumber("maxBodyBytes", options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES),
    maxAgeMs: validNumber("maxAgeMs", options.maxAgeMs, DEFAULT_MAX_AGE_MS),
    futureSkewMs: validNumber("futureSkewMs", options.futureSkewMs, DEFAULT_FUTURE_SKEW_MS),
    replayProtection: options.replayProtection ?? true,
    requireDeliveryId: options.requireDeliveryId ?? false,
    now: options.now ?? (() => Date.now())
  };
}

export function parseWebhook<T = unknown>(body: WebhookBody, headers: WebhookHeaders, optionsOrSecret: WebhookParseOptions | WebhookSecret): ParsedWebhook<T> {
  const options = normalizedParseOptions(optionsOrSecret);
  const rawBody = bodyText(body);
  if (bytes(body).byteLength > options.maxBodyBytes) throw new WebhookParseError("Webhook body exceeds the configured size limit");
  const signature = header(headers, options.signatureHeader);
  if (!verifyWebhookSignature(rawBody, signature, options.secret, options.replayProtection ? header(headers, options.timestampHeader) : undefined)) throw new WebhookSignatureError();
  const timestamp = options.replayProtection ? header(headers, options.timestampHeader) : undefined;
  if (options.replayProtection) {
    if (timestamp === undefined) throw new WebhookReplayError("Webhook timestamp is required");
    assertTimestamp(timestamp, options.now(), options.maxAgeMs, options.futureSkewMs);
  }
  const deliveryId = header(headers, options.deliveryIdHeader);
  if (options.requireDeliveryId && !deliveryId) throw new WebhookReplayError("Webhook delivery id is required");
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    throw new WebhookParseError();
  }
  return {
    payload: payload as T,
    rawBody,
    signature: signature as string,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(deliveryId === undefined ? {} : { deliveryId })
  };
}

export const verifyWebhook = verifyWebhookSignature;

function jsonBody(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload instanceof Uint8Array) return bodyText(payload);
  try {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) throw new TypeError();
    return serialized;
  } catch {
    throw new WebhookParseError("Webhook payload cannot be serialized as JSON");
  }
}

function retryAfter(headers: Headers, now: number): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(0, Math.round(Number(value) * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Webhook request timed out", "TimeoutError")), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
}

export class WebhookConnector {
  private readonly secret: WebhookSecret;
  private readonly dedupStore: WebhookDedupStore;
  private readonly fetchImpl: typeof fetch;
  private readonly parseOptions: WebhookParseOptions;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly userAgent: string | undefined;

  constructor(options: WebhookConnectorOptions) {
    if (options === null || typeof options !== "object") throw new TypeError("WebhookConnector options are required");
    this.secret = secretBytes(options.secret);
    const defaultFetch = globalThis.fetch;
    if (options.fetch === undefined && typeof defaultFetch !== "function") throw new TypeError("fetch is unavailable; inject fetch");
    this.fetchImpl = options.fetch ?? defaultFetch.bind(globalThis);
    this.dedupStore = options.dedupStore ?? new MemoryWebhookDedupStore();
    this.parseOptions = { ...options, secret: this.secret };
    this.maxRetries = Math.min(MAX_RETRIES, validNumber("maxRetries", options.maxRetries, DEFAULT_MAX_RETRIES));
    this.retryDelayMs = validNumber("retryDelayMs", options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
    this.maxRetryDelayMs = validNumber("maxRetryDelayMs", options.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS);
    this.timeoutMs = validNumber("timeoutMs", options.timeoutMs, DEFAULT_TIMEOUT_MS);
    if (this.timeoutMs === 0) throw new TypeError("timeoutMs must be greater than zero");
    this.userAgent = options.userAgent;
  }

  parse<T = unknown>(body: WebhookBody, headers: WebhookHeaders): ParsedWebhook<T> {
    return parseWebhook<T>(body, headers, this.parseOptions);
  }

  verify(body: WebhookBody, signature: string | undefined, timestamp?: string | number): boolean {
    return verifyWebhookSignature(body, signature, this.secret, timestamp);
  }

  async receive<T = unknown>(body: WebhookBody, headers: WebhookHeaders): Promise<ParsedWebhook<T> & { readonly duplicate: boolean }> {
    const parsed = this.parse<T>(body, headers);
    const key = parsed.deliveryId ?? `${parsed.timestamp ?? "raw"}:${parsed.signature}`;
    const record: WebhookDeliveryRecord = {
      key,
      receivedAt: this.parseOptions.now?.() ?? Date.now(),
      signature: parsed.signature,
      ...(parsed.deliveryId === undefined ? {} : { deliveryId: parsed.deliveryId })
    };
    const claimed = await this.dedupStore.claim(key, record);
    return { ...parsed, duplicate: !claimed };
  }

  async handle<T = unknown>(body: WebhookBody, headers: WebhookHeaders, handler: (payload: T, webhook: ParsedWebhook<T>) => Promise<void> | void): Promise<ParsedWebhook<T> & { readonly duplicate: boolean }> {
    const received = await this.receive<T>(body, headers);
    if (received.duplicate) return received;
    const key = received.deliveryId ?? `${received.timestamp ?? "raw"}:${received.signature}`;
    try {
      await handler(received.payload, received);
    } catch (error) {
      await this.dedupStore.release?.(key);
      throw error;
    }
    return received;
  }

  async deliver(request: WebhookDeliveryRequest): Promise<WebhookDeliveryResult> {
    const url = validUrl(request.url);
    const body = jsonBody(request.payload);
    const now = this.parseOptions.now?.() ?? Date.now();
    const timestamp = timestampSeconds(request.timestamp, now);
    const deliveryId = request.deliveryId ?? `wh_${timestamp}_${Math.random().toString(36).slice(2, 12)}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-webhook-id": deliveryId,
      "x-webhook-timestamp": timestamp,
      "x-webhook-signature": signWebhookPayload(body, this.secret, timestamp),
      ...(this.userAgent === undefined ? {} : { "user-agent": this.userAgent }),
      ...(request.headers ?? {})
    };
    headers["x-webhook-id"] = deliveryId;
    headers["x-webhook-timestamp"] = timestamp;
    headers["x-webhook-signature"] = signWebhookPayload(body, this.secret, timestamp);
    let lastStatus: number | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      const signal = requestSignal(request.signal, this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, { method: "POST", headers, body, signal: signal.signal });
        lastStatus = response.status;
        if (response.ok || !retryableStatus(response.status) || attempt > this.maxRetries) return { response, attempts: attempt };
        await sleep(retryAfter(response.headers, now) ?? Math.min(this.maxRetryDelayMs, this.retryDelayMs * 2 ** (attempt - 1)), request.signal);
      } catch (error) {
        lastError = error;
        if (request.signal?.aborted || attempt > this.maxRetries) throw new WebhookDeliveryError("Webhook delivery was aborted or failed", attempt, lastStatus, error);
        await sleep(Math.min(this.maxRetryDelayMs, this.retryDelayMs * 2 ** (attempt - 1)), request.signal);
      } finally {
        signal.cleanup();
      }
    }
    throw new WebhookDeliveryError("Webhook delivery failed", this.maxRetries + 1, lastStatus, lastError);
  }

  async send(request: WebhookDeliveryRequest): Promise<WebhookDeliveryResult> {
    return this.deliver(request);
  }
}

function validUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Webhook URL must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new TypeError("Webhook URL must be a valid HTTP(S) URL");
  return parsed.toString();
}
