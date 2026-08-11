import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { SourceReference, ValidationResult, VersionReference } from "@premise/protocol-types";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 100;
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;
const MAX_RETRIES = 5;
const DEFAULT_USER_AGENT = "@premise/validator-github/0.1";
const GITHUB_API_VERSION = "2022-11-28";
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export type GitHubVersionScheme =
  | "github.commit"
  | "github.issue"
  | "github.pull-request"
  | "github.pull-request.head"
  | "github.pull-request.checks"
  | "github.pull-request.reviews";

export interface GitHubVersion extends VersionReference {
  readonly scheme: GitHubVersionScheme;
}

export type GitHubSource =
  | { readonly kind: "commit"; readonly owner: string; readonly repo: string; readonly ref: string }
  | { readonly kind: "issue"; readonly owner: string; readonly repo: string; readonly number: number }
  | { readonly kind: "pull-request"; readonly owner: string; readonly repo: string; readonly number: number }
  | { readonly kind: "pull-request-head"; readonly owner: string; readonly repo: string; readonly number: number }
  | { readonly kind: "pull-request-checks"; readonly owner: string; readonly repo: string; readonly number: number }
  | { readonly kind: "pull-request-reviews"; readonly owner: string; readonly repo: string; readonly number: number };

export interface GitHubRequestOptions {
  readonly signal?: AbortSignal;
  readonly cache?: boolean;
}

export interface GitHubCacheEntry {
  readonly etag: string;
  readonly body: unknown;
}

export interface GitHubResponseCache {
  get(key: string): GitHubCacheEntry | undefined;
  set(key: string, value: GitHubCacheEntry): void;
}

export interface GitHubAdapterOptions {
  /** GitHub.com or a GitHub Enterprise API root. */
  readonly baseUrl?: string;
  /** A token is sent as a Bearer token; it is never included in errors. */
  readonly token?: string;
  readonly tokenProvider?: () => string | undefined | Promise<string | undefined>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly userAgent?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly cache?: GitHubResponseCache;
  readonly webhookSecret?: string;
  readonly now?: () => number;
}

export interface GitHubRateLimit {
  readonly limit: number;
  readonly remaining: number;
  readonly resetEpochSeconds: number;
  readonly resetAt: string;
  readonly used?: number;
  readonly resource?: string;
}

export interface GitHubRateLimitBucket {
  readonly limit: number;
  readonly remaining: number;
  readonly reset: number;
  readonly used: number;
  readonly resource?: string;
}

export interface GitHubRateLimitResponse {
  readonly resources: Readonly<Record<string, GitHubRateLimitBucket>>;
  readonly rate: GitHubRateLimitBucket;
}

export interface GitHubResponse<T> {
  readonly data: T;
  readonly status: number;
  readonly notModified: boolean;
  readonly etag?: string;
  readonly rateLimit?: GitHubRateLimit;
}

export type GitHubErrorCode =
  | "GITHUB_API_ERROR"
  | "GITHUB_RATE_LIMITED"
  | "GITHUB_TIMEOUT"
  | "GITHUB_NETWORK_ERROR"
  | "GITHUB_INVALID_RESPONSE"
  | "GITHUB_SOURCE_ERROR"
  | "GITHUB_CONFIGURATION_ERROR"
  | "GITHUB_WEBHOOK_ERROR"
  | "GITHUB_ABORTED";

export class GitHubError extends Error {
  readonly code: GitHubErrorCode;

  constructor(code: GitHubErrorCode, message: string) {
    super(message);
    this.name = "GitHubError";
    this.code = code;
  }
}

export class GitHubApiError extends GitHubError {
  readonly status: number;
  readonly requestId?: string;

  constructor(status: number, requestId?: string, code: "GITHUB_API_ERROR" | "GITHUB_RATE_LIMITED" = "GITHUB_API_ERROR") {
    super(code, `GitHub API request failed (${status})`);
    this.name = "GitHubApiError";
    this.status = status;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

export class GitHubRateLimitError extends GitHubApiError {
  readonly rateLimit?: GitHubRateLimit;
  readonly retryAfterMs?: number;

  constructor(status: number, rateLimit?: GitHubRateLimit, retryAfterMs?: number, requestId?: string) {
    super(status, requestId, "GITHUB_RATE_LIMITED");
    this.name = "GitHubRateLimitError";
    if (rateLimit !== undefined) this.rateLimit = rateLimit;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export class GitHubTimeoutError extends GitHubError {
  constructor() {
    super("GITHUB_TIMEOUT", "GitHub API request timed out");
    this.name = "GitHubTimeoutError";
  }
}

export class GitHubNetworkError extends GitHubError {
  constructor() {
    super("GITHUB_NETWORK_ERROR", "GitHub API request failed before a response was received");
    this.name = "GitHubNetworkError";
  }
}

export class GitHubInvalidResponseError extends GitHubError {
  constructor() {
    super("GITHUB_INVALID_RESPONSE", "GitHub API returned an invalid response");
    this.name = "GitHubInvalidResponseError";
  }
}

export class GitHubSourceError extends GitHubError {
  constructor() {
    super("GITHUB_SOURCE_ERROR", "Unsupported GitHub source URI");
    this.name = "GitHubSourceError";
  }
}

export class GitHubConfigurationError extends GitHubError {
  constructor(message: string) {
    super("GITHUB_CONFIGURATION_ERROR", message);
    this.name = "GitHubConfigurationError";
  }
}

export class GitHubWebhookError extends GitHubError {
  constructor() {
    super("GITHUB_WEBHOOK_ERROR", "Invalid GitHub webhook");
    this.name = "GitHubWebhookError";
  }
}

export class GitHubAbortError extends GitHubError {
  constructor() {
    super("GITHUB_ABORTED", "GitHub API request was aborted");
    this.name = "GitHubAbortError";
  }
}

export interface GitHubWebhook<T = unknown> {
  readonly event: string;
  readonly deliveryId?: string;
  readonly signature: string;
  readonly payload: T;
}

export type GitHubWebhookHeaders = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new GitHubSourceError();
  }
}

function sourceParts(sourceUri: string): { owner: string; repo: string; rest: string[] } {
  let parsed: URL;
  try {
    parsed = new URL(sourceUri);
  } catch {
    throw new GitHubSourceError();
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) throw new GitHubSourceError();
  const parts = parsed.pathname.split("/").filter(Boolean).map(decodePart);
  let owner: string;
  let repo: string | undefined;
  let rest: string[];
  if (parsed.protocol === "github:") {
    owner = decodePart(parsed.hostname);
    repo = parts.shift();
    rest = parts;
  } else if ((parsed.protocol === "https:" || parsed.protocol === "http:") && (parsed.hostname === "github.com" || parsed.hostname === "www.github.com")) {
    owner = parts.shift() ?? "";
    repo = parts.shift();
    rest = parts;
  } else {
    throw new GitHubSourceError();
  }
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || rest.length === 0) throw new GitHubSourceError();
  return { owner, repo, rest };
}

function parseNumber(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new GitHubSourceError();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new GitHubSourceError();
  return number;
}

export function parseGitHubSource(sourceUri: string): GitHubSource {
  const { owner, repo, rest } = sourceParts(sourceUri);
  const action = rest.shift();
  if (action === "commit" || action === "commits") {
    const ref = rest.join("/");
    if (!ref) throw new GitHubSourceError();
    return { kind: "commit", owner, repo, ref };
  }
  if (action === "issue" || action === "issues") {
    if (rest.length !== 1) throw new GitHubSourceError();
    return { kind: "issue", owner, repo, number: parseNumber(rest[0]) };
  }
  if (action === "pull" || action === "pulls" || action === "pr") {
    const number = parseNumber(rest.shift());
    if (rest.length === 0) return { kind: "pull-request", owner, repo, number };
    if (rest.length !== 1) throw new GitHubSourceError();
    if (rest[0] === "head") return { kind: "pull-request-head", owner, repo, number };
    if (rest[0] === "checks" || rest[0] === "check-runs") return { kind: "pull-request-checks", owner, repo, number };
    if (rest[0] === "reviews") return { kind: "pull-request-reviews", owner, repo, number };
  }
  throw new GitHubSourceError();
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new GitHubInvalidResponseError();
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new GitHubInvalidResponseError();
  return value;
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return "null";
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function cloneResponse<T>(response: GitHubResponse<T>): GitHubResponse<T> {
  return structuredClone(response);
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value);
}

function repositoryPath(source: GitHubSource): string {
  return `/repos/${encodePathPart(source.owner)}/${encodePathPart(source.repo)}`;
}

function parseHeaderNumber(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (!value || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function parseRateLimit(headers: Headers): GitHubRateLimit | undefined {
  const limit = parseHeaderNumber(headers, "x-ratelimit-limit");
  const remaining = parseHeaderNumber(headers, "x-ratelimit-remaining");
  const resetEpochSeconds = parseHeaderNumber(headers, "x-ratelimit-reset");
  if (limit === undefined || remaining === undefined || resetEpochSeconds === undefined) return undefined;
  const used = parseHeaderNumber(headers, "x-ratelimit-used");
  const resource = headers.get("x-ratelimit-resource") ?? undefined;
  return {
    limit,
    remaining,
    resetEpochSeconds,
    resetAt: new Date(resetEpochSeconds * 1000).toISOString(),
    ...(used === undefined ? {} : { used }),
    ...(resource === undefined ? {} : { resource })
  };
}

function parseRetryAfter(headers: Headers, now: () => number): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(0, Math.round(Number(value) * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now());
}

function validateNonNegative(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new GitHubConfigurationError(`${name} must be a non-negative finite number`);
  return Math.trunc(value);
}

function timeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let onAbort: (() => void) | undefined;
  if (signal) {
    onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
}

function sleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (milliseconds <= 0) {
    if (signal?.aborted) return Promise.reject(new GitHubAbortError());
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new GitHubAbortError());
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function webhookHeader(headers: GitHubWebhookHeaders, name: string): string | undefined {
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function webhookBytes(payload: string | Uint8Array): Uint8Array {
  return typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
}

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

export function signWebhookPayload(payload: string | Uint8Array, secret: string): string {
  if (secret.length === 0) throw new GitHubWebhookError();
  return `sha256=${createHmac("sha256", secret).update(webhookBytes(payload)).digest("hex")}`;
}

export function verifyWebhookSignature(payload: string | Uint8Array, signature: string | undefined, secret: string | undefined): boolean {
  if (!secret || !signature) return false;
  const normalized = signature.trim().toLowerCase();
  if (!/^sha256=[0-9a-f]{64}$/.test(normalized)) return false;
  const expected = hexBytes(signWebhookPayload(payload, secret).slice("sha256=".length));
  const actual = hexBytes(normalized.slice("sha256=".length));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function parseWebhook<T = unknown>(payload: string | Uint8Array, headers: GitHubWebhookHeaders, secret: string): GitHubWebhook<T> {
  const signature = webhookHeader(headers, "x-hub-signature-256");
  if (!verifyWebhookSignature(payload, signature, secret)) throw new GitHubWebhookError();
  const event = webhookHeader(headers, "x-github-event");
  if (!event) throw new GitHubWebhookError();
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(webhookBytes(payload)));
  } catch {
    throw new GitHubWebhookError();
  }
  const deliveryId = webhookHeader(headers, "x-github-delivery");
  return { event, signature: signature as string, payload: decoded as T, ...(deliveryId === undefined ? {} : { deliveryId }) };
}

export const signWebhook = signWebhookPayload;
export const verifyWebhook = verifyWebhookSignature;

export class GitHubValidator {
  readonly id = "github";
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: string | undefined;
  private readonly tokenProvider: (() => string | undefined | Promise<string | undefined>) | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly userAgent: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly cache: GitHubResponseCache;
  private readonly inFlight = new Map<string, Promise<GitHubResponse<unknown>>>();
  private readonly webhookSecret: string | undefined;
  private readonly now: () => number;
  private rateLimitState?: GitHubRateLimit;

  constructor(options: GitHubAdapterOptions = {}) {
    let parsedBase: URL;
    try {
      parsedBase = new URL(options.baseUrl ?? DEFAULT_API_BASE_URL);
    } catch {
      throw new GitHubConfigurationError("baseUrl must be a valid HTTP(S) URL");
    }
    if (parsedBase.protocol !== "http:" && parsedBase.protocol !== "https:") throw new GitHubConfigurationError("baseUrl must be a valid HTTP(S) URL");
    if (parsedBase.search.length > 0 || parsedBase.hash.length > 0) throw new GitHubConfigurationError("baseUrl must not contain a query or fragment");
    this.baseUrl = parsedBase.toString().replace(/\/+$/, "");
    const defaultFetch = globalThis.fetch;
    if (options.fetch === undefined && typeof defaultFetch !== "function") throw new GitHubConfigurationError("global fetch is not available; inject fetch");
    this.fetchImpl = options.fetch ?? defaultFetch.bind(globalThis);
    if (options.token !== undefined && options.tokenProvider !== undefined) throw new GitHubConfigurationError("token and tokenProvider are mutually exclusive");
    this.token = options.token;
    this.tokenProvider = options.tokenProvider;
    this.timeoutMs = validateNonNegative("timeoutMs", options.timeoutMs, DEFAULT_TIMEOUT_MS);
    if (this.timeoutMs === 0) throw new GitHubConfigurationError("timeoutMs must be greater than zero");
    this.maxRetries = Math.min(MAX_RETRIES, validateNonNegative("maxRetries", options.maxRetries, DEFAULT_MAX_RETRIES));
    this.retryDelayMs = validateNonNegative("retryDelayMs", options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
    this.maxRetryDelayMs = validateNonNegative("maxRetryDelayMs", options.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS);
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    if (this.userAgent.length === 0) throw new GitHubConfigurationError("userAgent must not be empty");
    this.headers = { ...(options.headers ?? {}) };
    this.cache = options.cache ?? new Map<string, GitHubCacheEntry>();
    this.webhookSecret = options.webhookSecret;
    this.now = options.now ?? (() => Date.now());
  }

  get lastRateLimit(): GitHubRateLimit | undefined {
    return this.rateLimitState;
  }

  verifyWebhook(payload: string | Uint8Array, signature?: string): boolean {
    return verifyWebhookSignature(payload, signature, this.webhookSecret);
  }

  parseWebhook<T = unknown>(payload: string | Uint8Array, headers: GitHubWebhookHeaders): GitHubWebhook<T> {
    if (!this.webhookSecret) throw new GitHubWebhookError();
    return parseWebhook<T>(payload, headers, this.webhookSecret);
  }

  async get<T>(path: string, options: GitHubRequestOptions = {}): Promise<T> {
    return (await this.request<T>(path, options)).data;
  }

  async request<T>(path: string, options: GitHubRequestOptions = {}): Promise<GitHubResponse<T>> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new GitHubConfigurationError("GitHub API paths must be relative paths");
    const url = new URL(path.slice(1), `${this.baseUrl}/`).toString();
    const cached = options.cache === false ? undefined : this.cache.get(url);
    if (options.signal === undefined && this.tokenProvider === undefined) {
      const key = `${options.cache === false ? "no-cache" : `cache:${cached?.etag ?? ""}`}|${url}`;
      const existing = this.inFlight.get(key);
      if (existing !== undefined) return existing.then((response) => cloneResponse(response as GitHubResponse<T>));
      const pending = this.requestDirect<T>(url, options, cached);
      this.inFlight.set(key, pending as Promise<GitHubResponse<unknown>>);
      const clear = () => {
        if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
      };
      void pending.then(clear, clear);
      return pending.then(cloneResponse);
    }
    return this.requestDirect<T>(url, options, cached);
  }

  private async requestDirect<T>(url: string, options: GitHubRequestOptions, cached: GitHubCacheEntry | undefined): Promise<GitHubResponse<T>> {
    const retryCount = this.maxRetries + 1;
    for (let attempt = 0; attempt < retryCount; attempt += 1) {
      const timed = timeoutSignal(options.signal, this.timeoutMs);
      try {
        const headers: Record<string, string> = {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": this.userAgent,
          ...this.headers
        };
        const token = await this.resolveToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        if (cached?.etag && options.cache !== false) headers["If-None-Match"] = cached.etag;
        let response: Response;
        try {
          response = await this.fetchImpl(url, { method: "GET", headers, signal: timed.signal });
        } catch {
          if (options.signal?.aborted && !timed.timedOut()) throw new GitHubAbortError();
          if (timed.timedOut()) {
            if (attempt < this.maxRetries) {
              await sleep(this.retryDelayMsFor(attempt), options.signal);
              continue;
            }
            throw new GitHubTimeoutError();
          }
          if (attempt < this.maxRetries) {
            await sleep(this.retryDelayMsFor(attempt), options.signal);
            continue;
          }
          throw new GitHubNetworkError();
        }
        const rateLimit = parseRateLimit(response.headers);
        if (rateLimit) this.rateLimitState = rateLimit;
        const requestId = response.headers.get("x-github-request-id") ?? undefined;
        if (response.status === 304) {
          if (!cached) throw new GitHubInvalidResponseError();
          return { data: cached.body as T, status: 304, notModified: true, etag: cached.etag, ...(rateLimit === undefined ? {} : { rateLimit }) };
        }
        if (response.status >= 200 && response.status < 300) {
          let data: unknown;
          try {
            data = response.status === 204 ? undefined : await response.json();
          } catch {
            throw new GitHubInvalidResponseError();
          }
          const etag = response.headers.get("etag") ?? undefined;
          if (etag && options.cache !== false) this.cache.set(url, { etag, body: data });
          return { data: data as T, status: response.status, notModified: false, ...(etag === undefined ? {} : { etag }), ...(rateLimit === undefined ? {} : { rateLimit }) };
        }
        const rateLimited = response.status === 429 || (response.status === 403 && (rateLimit?.remaining === 0 || response.headers.get("retry-after") !== null));
        if (rateLimited) {
          const retryAfterMs = this.retryAfterMs(response.headers, rateLimit);
          if (attempt < this.maxRetries) {
            await sleep(this.retryDelayMsFor(attempt, retryAfterMs), options.signal);
            continue;
          }
          throw new GitHubRateLimitError(response.status, rateLimit, retryAfterMs, requestId);
        }
        if (RETRYABLE_STATUSES.has(response.status) && attempt < this.maxRetries) {
          await sleep(this.retryDelayMsFor(attempt), options.signal);
          continue;
        }
        throw new GitHubApiError(response.status, requestId);
      } catch (error) {
        if (error instanceof GitHubError) throw error;
        throw new GitHubNetworkError();
      } finally {
        timed.cleanup();
      }
    }
    throw new GitHubNetworkError();
  }

  async getRateLimit(options: GitHubRequestOptions = {}): Promise<GitHubRateLimitResponse> {
    const response = await this.get<unknown>("/rate_limit", { ...options, cache: false });
    if (!isRecord(response) || !isRecord(response.resources) || !isRecord(response.rate)) throw new GitHubInvalidResponseError();
    return response as unknown as GitHubRateLimitResponse;
  }

  async rateLimit(options: GitHubRequestOptions = {}): Promise<GitHubRateLimitResponse> {
    return this.getRateLimit(options);
  }

  async versionFor(sourceUri: string, options: GitHubRequestOptions = {}): Promise<GitHubVersion> {
    const source = parseGitHubSource(sourceUri);
    switch (source.kind) {
      case "commit": {
        const commit = await this.getRecord(`${repositoryPath(source)}/commits/${encodePathPart(source.ref)}`, options);
        return { scheme: "github.commit", token: requiredString(commit, "sha") };
      }
      case "issue": {
        const issue = await this.getRecord(`${repositoryPath(source)}/issues/${source.number}`, options);
        const updatedAt = requiredString(issue, "updated_at");
        const state = requiredString(issue, "state");
        const stateReason = optionalString(issue, "state_reason") ?? "";
        return { scheme: "github.issue", token: `${updatedAt}|${state}|${stateReason}` };
      }
      case "pull-request": {
        const pull = await this.getRecord(`${repositoryPath(source)}/pulls/${source.number}`, options);
        return { scheme: "github.pull-request", token: this.pullToken(pull) };
      }
      case "pull-request-head": {
        const pull = await this.getRecord(`${repositoryPath(source)}/pulls/${source.number}`, options);
        const head = requiredRecord(pull, "head");
        return { scheme: "github.pull-request.head", token: requiredString(head, "sha") };
      }
      case "pull-request-checks": {
        const pull = await this.getRecord(`${repositoryPath(source)}/pulls/${source.number}`, options);
        const head = requiredRecord(pull, "head");
        const headSha = requiredString(head, "sha");
        const checks = await this.getRecord(`${repositoryPath(source)}/commits/${encodePathPart(headSha)}/check-runs?per_page=100`, options);
        if (!Array.isArray(checks.check_runs)) throw new GitHubInvalidResponseError();
        return { scheme: "github.pull-request.checks", token: `${headSha}|${digest(checks.check_runs)}` };
      }
      case "pull-request-reviews": {
        const reviews = await this.get<unknown[]>(`${repositoryPath(source)}/pulls/${source.number}/reviews?per_page=100`, options);
        if (!Array.isArray(reviews)) throw new GitHubInvalidResponseError();
        return { scheme: "github.pull-request.reviews", token: digest(reviews) };
      }
    }
  }

  async validate(source: SourceReference & { readonly memoryId?: string }, options: GitHubRequestOptions = {}): Promise<ValidationResult> {
    const memoryId = source.memoryId ?? source.sourceUri;
    try {
      const version = await this.versionFor(source.sourceUri, options);
      const result = source.version && (source.version.scheme !== version.scheme || source.version.token !== version.token) ? "CHANGED" : "UNCHANGED";
      return { memoryId, result, status: result === "UNCHANGED" ? "FRESH" : "INVALID", checkedAt: new Date(this.now()).toISOString(), sourceUri: source.sourceUri, version };
    } catch (error) {
      const result = error instanceof GitHubApiError && error.status === 404 ? "MISSING" : "UNKNOWN";
      return { memoryId, result, status: result === "MISSING" ? "INVALID" : "UNKNOWN", checkedAt: new Date(this.now()).toISOString(), sourceUri: source.sourceUri };
    }
  }

  private async getRecord(path: string, options: GitHubRequestOptions): Promise<Record<string, unknown>> {
    const value = await this.get<unknown>(path, options);
    if (!isRecord(value)) throw new GitHubInvalidResponseError();
    return value;
  }

  private pullToken(pull: Record<string, unknown>): string {
    const head = requiredRecord(pull, "head");
    const headSha = requiredString(head, "sha");
    const updatedAt = requiredString(pull, "updated_at");
    const state = requiredString(pull, "state");
    const mergedAt = optionalString(pull, "merged_at") ?? "";
    const stateReason = optionalString(pull, "state_reason") ?? "";
    return `${headSha}|${updatedAt}|${state}|${mergedAt}|${stateReason}`;
  }

  private async resolveToken(): Promise<string | undefined> {
    if (!this.tokenProvider) return this.token;
    let value: string | undefined;
    try {
      value = await this.tokenProvider();
    } catch {
      throw new GitHubConfigurationError("tokenProvider failed");
    }
    if (value !== undefined && typeof value !== "string") throw new GitHubConfigurationError("tokenProvider must return a string or undefined");
    return value || undefined;
  }

  private retryDelayMsFor(attempt: number, requestedMs?: number): number {
    const backoff = this.retryDelayMs * 2 ** attempt;
    return Math.min(this.maxRetryDelayMs, Math.max(backoff, requestedMs ?? 0));
  }

  private retryAfterMs(headers: Headers, rateLimit: GitHubRateLimit | undefined): number | undefined {
    const fromHeader = parseRetryAfter(headers, this.now);
    if (fromHeader !== undefined) return Math.min(this.maxRetryDelayMs, fromHeader);
    if (rateLimit?.remaining === 0) return Math.min(this.maxRetryDelayMs, Math.max(0, rateLimit.resetEpochSeconds * 1000 - this.now()));
    return undefined;
  }
}

export { GitHubValidator as GitHubAdapter, GitHubValidator as GitHubRestAdapter };
