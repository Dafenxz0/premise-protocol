export const SDK_VERSION = "2.0.0-rc.2" as const;
export const SDK_RELEASE_CHANNEL = "candidate" as const;
export const API_SPEC_VERSION = "premise/2" as const;
export const SPEC_VERSION_V2 = API_SPEC_VERSION;
export const MAX_QUERY_HITS = 1_000 as const;

export type V2MemoryStatus = "FRESH" | "STALE" | "INVALID" | "UNKNOWN";
export type V2ValidityPolicy = "IMMUTABLE" | "VERSIONED" | "TTL" | "MANUAL";
export type ValidationOutcome = "UNCHANGED" | "CHANGED" | "MISSING" | "UNKNOWN";

export interface VersionReference {
  readonly scheme: string;
  readonly token: string;
}

export interface ValidatorReference {
  readonly id: string;
  readonly operation: string;
}

export interface ConfidenceDeclaration {
  readonly score: number | null;
  readonly method: string;
  readonly assessedAt?: string;
  readonly rationale?: string;
}

export interface EvidenceReference {
  readonly evidenceId: string;
  readonly sourceUri: string;
  readonly observedAt: string;
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly version?: VersionReference;
  readonly validator?: ValidatorReference;
  readonly confidence?: ConfidenceDeclaration;
  readonly kind?: string;
}

export interface TemporalDeclaration {
  readonly asOf: string;
  readonly validFrom?: string;
  readonly validUntil?: string;
}

export type ConflictStatus = "OPEN" | "RESOLVED";
export type ConflictResolutionStrategy = "MANUAL" | "PREFER_CONFIDENCE" | "PREFER_NEWEST" | "MERGE";

export interface ConflictResolution {
  readonly strategy: ConflictResolutionStrategy;
  readonly resolvedAt: string;
  readonly selectedEvidenceId?: string;
  readonly note?: string;
}

export interface EvidenceConflict {
  readonly conflictId: string;
  readonly evidenceIds: readonly [string, string, ...string[]];
  readonly status: ConflictStatus;
  readonly resolution?: ConflictResolution;
}

export interface DeclaredSignature {
  readonly signatureId: string;
  readonly signerId: string;
  readonly keyId: string;
  readonly algorithm: string;
  readonly value: string;
  readonly signedAt: string;
  readonly evidenceId?: string;
}

export interface MemoryValidity {
  readonly status: V2MemoryStatus;
  readonly checkedAt: string;
  readonly policy: V2ValidityPolicy;
  readonly expiresAt?: string;
}

export type V2Validity = MemoryValidity;

export interface MemoryEnvelopeV2 {
  readonly specVersion: typeof API_SPEC_VERSION;
  readonly tenantId: string;
  readonly memoryId: string;
  readonly contentDigest?: string;
  readonly evidence: readonly EvidenceReference[];
  readonly confidence: ConfidenceDeclaration;
  readonly conflicts: readonly EvidenceConflict[];
  readonly temporal: TemporalDeclaration;
  readonly validity: MemoryValidity;
  readonly dependsOn: readonly string[];
  readonly signatures: readonly DeclaredSignature[];
}

export interface MemoryRecord<T = unknown> {
  readonly envelope: MemoryEnvelopeV2;
  readonly content: T;
}

export type RuntimeRecord<T = unknown> = MemoryRecord<T>;

export interface HealthResponse {
  readonly ok: boolean;
  readonly specVersion: typeof API_SPEC_VERSION;
  readonly memories: number;
  readonly events: number;
}

export interface CapabilitiesResponse {
  readonly specVersion: typeof API_SPEC_VERSION;
  readonly capabilities: readonly string[];
}

export interface StoreMemoryResponse {
  readonly memoryId: string;
  readonly status: string;
}

export type MetadataScalar = string | number | boolean | null;
export type MetadataValue = MetadataScalar | readonly MetadataScalar[];
export type MetadataFilter = Readonly<Record<string, unknown>>;

export interface QuerySearchOptions {
  readonly limit?: number;
  readonly filter?: MetadataFilter;
  readonly filters?: MetadataFilter;
  readonly lexicalWeight?: number;
  readonly vectorWeight?: number;
  readonly minScore?: number;
  readonly [key: string]: unknown;
}

export interface QueryRequest {
  readonly query: string;
  readonly options?: QuerySearchOptions;
  readonly maxTokens?: number;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export type QueryInputOptions = Omit<QueryRequest, "query">;

export interface QueryHit<T = unknown> {
  readonly id: string;
  readonly text: string;
  readonly score: number;
  readonly lexicalScore?: number;
  readonly vectorScore?: number;
  readonly content?: T;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly document?: Readonly<Record<string, unknown>>;
  readonly explanation?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface ContextChunk {
  readonly id: string;
  readonly sourceId?: string;
  readonly memoryId?: string;
  readonly text?: string;
  readonly content?: string;
  readonly tokens?: number;
  readonly freshness?: V2MemoryStatus;
  readonly [key: string]: unknown;
}

export interface ContextPlan {
  readonly selected: readonly ContextChunk[];
  readonly trace?: readonly Record<string, unknown>[];
  readonly omitted?: readonly Record<string, unknown>[];
  readonly tokenBudget?: number;
  readonly usableTokenBudget?: number;
  readonly reservedTokens?: number;
  readonly tokensUsed?: number;
  readonly remainingTokens?: number;
  readonly degraded?: boolean;
  readonly [key: string]: unknown;
}

export interface PageInfo {
  readonly pageSize?: number;
  readonly nextPageToken?: string;
}

export interface QueryResponse<T = unknown> {
  readonly hits: readonly QueryHit<T>[];
  readonly context: ContextPlan;
  readonly page?: PageInfo;
  readonly nextPageToken?: string;
  readonly [key: string]: unknown;
}

export interface RevalidationReport {
  readonly memoryId: string;
  readonly result: ValidationOutcome;
  readonly status: V2MemoryStatus;
  readonly checkedAt: string;
  readonly sourceUri?: string;
  readonly version?: VersionReference;
  readonly evidenceId?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export type ValidationResult = RevalidationReport;
export type RuntimeValidationReport = RevalidationReport;

export interface SourceChangedRequest {
  readonly sourceUri: string;
  readonly version: VersionReference;
}

export interface SourceChangedResponse {
  readonly affected: readonly string[];
  readonly nextPageToken?: string;
  readonly [key: string]: unknown;
}

export interface ApiErrorObject {
  readonly code?: string;
  readonly message?: string;
  readonly details?: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface ApiErrorResponse {
  readonly error: string | ApiErrorObject;
  readonly message?: string;
  readonly requestId?: string;
  readonly details?: readonly unknown[];
  readonly [key: string]: unknown;
}

const RETRYABLE_STATUS_CODES = new Set<number>([408, 425, 429, 500, 502, 503, 504]);

export type RetryableStatus = 408 | 425 | 429 | 500 | 502 | 503 | 504;

export interface RetryOptions {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitter?: number;
  readonly retryOn?: readonly number[];
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retries?: number;
  readonly retry?: RetryOptions;
  readonly idempotencyKey?: string;
  readonly requestId?: string;
  readonly headers?: HeadersInit;
}

export interface QueryAllOptions extends RequestOptions {
  readonly maxPages?: number;
}

export type AuthorizationProvider = string | (() => string | undefined | Promise<string | undefined>);
export type FetchImplementation = typeof fetch;
export type SleepImplementation = (milliseconds: number) => Promise<void>;
export type Logger = (event: SdkLogEvent) => void;

export interface PremiseClientOptions {
  readonly baseUrl: string | URL;
  /** Reject plain HTTP endpoints; useful for production configuration. */
  readonly requireHttps?: boolean;
  readonly tenantId?: string;
  readonly subjectId?: string;
  readonly token?: string;
  readonly authorization?: AuthorizationProvider;
  readonly headers?: HeadersInit;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retries?: number;
  readonly retry?: RetryOptions;
  readonly fetch?: FetchImplementation;
  readonly sleep?: SleepImplementation;
  readonly random?: () => number;
  readonly logger?: Logger;
}

export interface SdkLogEvent {
  readonly type: "request" | "response" | "retry" | "error";
  readonly method: string;
  readonly url: string;
  readonly attempt: number;
  readonly status?: number;
  readonly requestId?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly code?: string;
  readonly message?: string;
  readonly delayMs?: number;
  readonly nextAttempt?: number;
}

export type PremiseErrorCode =
  | "TIMEOUT"
  | "ABORTED"
  | "NETWORK_ERROR"
  | "INVALID_JSON"
  | "INVALID_RESPONSE"
  | "PAGINATION_ERROR"
  | "INVALID_REQUEST"
  | string;

export interface PremiseErrorOptions {
  readonly status?: number;
  readonly requestId?: string;
  readonly details?: readonly unknown[];
  readonly body?: unknown;
  readonly cause?: unknown;
}

export class PremiseSdkError extends Error {
  readonly code: PremiseErrorCode;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly details: readonly unknown[] | undefined;
  readonly body: unknown;

  constructor(message: string, code: PremiseErrorCode, options: PremiseErrorOptions = {}) {
    super(message);
    this.name = "PremiseSdkError";
    this.code = code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.details = options.details;
    this.body = options.body;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export class PremiseHttpError extends PremiseSdkError {
  override readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly responseHeaders: Readonly<Record<string, string>>;

  constructor(input: {
    readonly code: string;
    readonly message: string;
    readonly status: number;
    readonly method: string;
    readonly url: string;
    readonly responseHeaders: Readonly<Record<string, string>>;
    readonly requestId?: string;
    readonly details?: readonly unknown[];
    readonly body: unknown;
  }) {
    super(input.message, input.code, {
      status: input.status,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.details === undefined ? {} : { details: input.details }),
      body: input.body
    });
    this.name = "PremiseHttpError";
    this.status = input.status;
    this.method = input.method;
    this.url = input.url;
    this.responseHeaders = input.responseHeaders;
  }
}

export class PremiseTimeoutError extends PremiseSdkError {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number, requestId?: string, cause?: unknown) {
    super(message, "TIMEOUT", {
      ...(requestId === undefined ? {} : { requestId }),
      ...(cause === undefined ? {} : { cause })
    });
    this.name = "PremiseTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class PremiseAbortError extends PremiseSdkError {
  constructor(message: string, requestId?: string, cause?: unknown) {
    super(message, "ABORTED", {
      ...(requestId === undefined ? {} : { requestId }),
      ...(cause === undefined ? {} : { cause })
    });
    this.name = "PremiseAbortError";
  }
}

export class PremiseNetworkError extends PremiseSdkError {
  constructor(message: string, requestId?: string, cause?: unknown) {
    super(message, "NETWORK_ERROR", {
      ...(requestId === undefined ? {} : { requestId }),
      ...(cause === undefined ? {} : { cause })
    });
    this.name = "PremiseNetworkError";
  }
}

export class PremiseDecodeError extends PremiseSdkError {
  constructor(message: string, options: PremiseErrorOptions = {}) {
    super(message, "INVALID_JSON", options);
    this.name = "PremiseDecodeError";
  }
}

export class PremisePaginationError extends PremiseSdkError {
  constructor(message: string) {
    super(message, "PAGINATION_ERROR");
    this.name = "PremisePaginationError";
  }
}

export { PremiseSdkError as PremiseError, PremiseHttpError as PremiseApiError };

export function isPremiseError(value: unknown): value is PremiseSdkError {
  return value instanceof PremiseSdkError;
}

/** Returns whether the SDK can retry this error with its default retry statuses. */
export function isRetryablePremiseError(value: unknown): boolean {
  return value instanceof PremiseHttpError
    ? RETRYABLE_STATUS_CODES.has(value.status)
    : value instanceof PremiseTimeoutError || value instanceof PremiseNetworkError;
}

interface ResolvedRetryOptions {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: number;
  readonly retryOn: ReadonlySet<number>;
}

interface PreparedRequest {
  readonly headers: Headers;
  readonly body: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly requestId: string;
}

interface NormalizedQueryCall {
  readonly request: QueryRequest;
  readonly requestOptions: RequestOptions | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 5_000;
const DEFAULT_JITTER = 0.2;
const DEFAULT_RETRY_ON: readonly number[] = [408, 425, 429, 500, 502, 503, 504];
const SENSITIVE_HEADER = /authorization|proxy-auth|cookie|set-cookie|api[-_]?key|token|secret|password|idempotency-key/iu;
const SENSITIVE_QUERY = /auth|key|token|secret|password|signature/iu;
let fallbackKeySequence = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(label + " must be a non-empty string");
  return value;
}

function visibleAscii(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || !/^[\x21-\x7e]+$/u.test(value)) {
    throw new TypeError(`${label} must be 1-${maxLength} visible ASCII characters`);
  }
  return value;
}

function positiveInteger(value: number, label: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) throw new RangeError(label + " must be a " + (allowZero ? "non-negative" : "positive") + " safe integer");
  return value;
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(label + " must be a finite non-negative number");
  return value;
}

function finiteJitter(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError("retry.jitter must be between 0 and 1");
  return value;
}

function resolveRetry(
  options: RetryOptions | undefined,
  maxRetriesOverride: number | undefined,
  fallback: ResolvedRetryOptions = {
    maxRetries: DEFAULT_MAX_RETRIES,
    baseDelayMs: DEFAULT_BASE_DELAY_MS,
    maxDelayMs: DEFAULT_MAX_DELAY_MS,
    jitter: DEFAULT_JITTER,
    retryOn: new Set(DEFAULT_RETRY_ON)
  }
): ResolvedRetryOptions {
  const maxRetries = maxRetriesOverride ?? options?.maxRetries ?? fallback.maxRetries;
  const baseDelayMs = options?.baseDelayMs ?? fallback.baseDelayMs;
  const maxDelayMs = options?.maxDelayMs ?? fallback.maxDelayMs;
  const jitter = options?.jitter ?? fallback.jitter;
  const retryOn = options?.retryOn ?? [...fallback.retryOn];
  positiveInteger(maxRetries, "maxRetries", true);
  finiteNonNegative(baseDelayMs, "retry.baseDelayMs");
  finiteNonNegative(maxDelayMs, "retry.maxDelayMs");
  if (maxDelayMs < baseDelayMs) throw new RangeError("retry.maxDelayMs must be greater than or equal to retry.baseDelayMs");
  finiteJitter(jitter);
  if (retryOn.length === 0 || retryOn.some((status) => !Number.isSafeInteger(status) || status < 100 || status > 599)) {
    throw new RangeError("retry.retryOn must contain HTTP status codes");
  }
  return { maxRetries, baseDelayMs, maxDelayMs, jitter, retryOn: new Set(retryOn) };
}

function makeIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return "sdk:" + uuid;
  fallbackKeySequence += 1;
  return "sdk:" + Date.now().toString(36) + ":" + fallbackKeySequence.toString(36);
}

function makeRequestId(): string {
  return makeIdempotencyKey().replace(/^sdk:/u, "req:");
}

function normalizeBaseUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("baseUrl must use http or https");
  if (url.search.length > 0 || url.hash.length > 0) throw new TypeError("baseUrl must not include a query or fragment");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function redactUrl(value: string): string {
  const url = new URL(value);
  for (const [key] of url.searchParams) if (SENSITIVE_QUERY.test(key)) url.searchParams.set(key, "[REDACTED]");
  return url.toString();
}

function redactHeaders(value: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  value.forEach((headerValue, headerName) => {
    result[headerName] = SENSITIVE_HEADER.test(headerName) ? "[REDACTED]" : headerValue;
  });
  return result;
}

function responseHeaders(value: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  value.forEach((headerValue, headerName) => { result[headerName] = headerValue; });
  return result;
}

function responseRequestId(value: Headers): string | undefined {
  return value.get("x-request-id") ?? value.get("request-id") ?? undefined;
}

function bodyRequestId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.requestId !== "string") return undefined;
  return /^[\x21-\x7e]{1,128}$/u.test(value.requestId) ? value.requestId : undefined;
}

function errorDescription(status: number, body: unknown): {
  readonly code: string;
  readonly message: string;
  readonly details?: readonly unknown[];
  readonly requestId?: string;
} {
  const fallbackCode = "HTTP_" + status;
  if (typeof body === "string" && body.length > 0) return { code: fallbackCode, message: body };
  if (isRecord(body)) {
    const rawError = body.error;
    const topLevelMessage = typeof body.message === "string" && body.message.length > 0 ? body.message : undefined;
    const topLevelDetails = Array.isArray(body.details) ? body.details : undefined;
    const requestId = bodyRequestId(body);
    if (typeof rawError === "string" && rawError.length > 0) {
      return {
        code: topLevelMessage === undefined ? fallbackCode : rawError,
        message: topLevelMessage ?? rawError,
        ...(topLevelDetails === undefined ? {} : { details: topLevelDetails }),
        ...(requestId === undefined ? {} : { requestId })
      };
    }
    if (isRecord(rawError)) {
      const code = typeof rawError.code === "string" && rawError.code.length > 0 ? rawError.code : fallbackCode;
      const message = typeof rawError.message === "string" && rawError.message.length > 0 ? rawError.message : "PREMiSE API request failed";
      const details = Array.isArray(rawError.details) ? rawError.details : undefined;
      return { code, message, ...(details === undefined ? {} : { details }), ...(requestId === undefined ? {} : { requestId }) };
    }
    if (topLevelMessage !== undefined) return {
      code: fallbackCode,
      message: topLevelMessage,
      ...(topLevelDetails === undefined ? {} : { details: topLevelDetails }),
      ...(requestId === undefined ? {} : { requestId })
    };
    return {
      code: fallbackCode,
      message: "PREMiSE API request failed with HTTP " + status,
      ...(requestId === undefined ? {} : { requestId })
    };
  }
  return { code: fallbackCode, message: "PREMiSE API request failed with HTTP " + status };
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    const requestId = responseRequestId(response.headers);
    throw new PremiseDecodeError("PREMiSE API returned invalid JSON", {
      status: response.status,
      ...(requestId === undefined ? {} : { requestId }),
      body: text,
      cause
    });
  }
}

async function responseBodyLenient(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isRequestOptions(value: unknown): value is RequestOptions {
  if (!isRecord(value)) return false;
  return ["signal", "timeoutMs", "maxRetries", "retries", "retry", "idempotencyKey", "requestId", "headers", "maxPages"].some((key) => hasOwn(value, key));
}

function normalizeQueryCall(
  input: QueryRequest | string,
  second: RequestOptions | QueryInputOptions | QuerySearchOptions | undefined,
  third: RequestOptions | undefined
): NormalizedQueryCall {
  if (typeof input !== "string") {
    return { request: input, requestOptions: second as RequestOptions | undefined };
  }
  if (isRequestOptions(second)) return { request: { query: input }, requestOptions: second };
  if (isRecord(second) && (hasOwn(second, "options") || hasOwn(second, "maxTokens") || hasOwn(second, "pageSize") || hasOwn(second, "pageToken"))) {
    return { request: { query: input, ...(second as QueryInputOptions) }, requestOptions: third };
  }
  return {
    request: { query: input, ...(second === undefined ? {} : { options: second as QuerySearchOptions }) },
    requestOptions: third
  };
}

function queryBody(input: QueryRequest): Record<string, unknown> {
  if (!isRecord(input)) throw new TypeError("query input must be an object");
  requiredString(input.query, "query");
  if (input.options !== undefined && !isRecord(input.options)) throw new TypeError("options must be an object");
  const options = input.options;
  if (options !== undefined && hasOwn(options, "filter") && hasOwn(options, "filters")) {
    throw new TypeError("Use either options.filter or options.filters, not both");
  }
  if (options?.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0 || options.limit > MAX_QUERY_HITS)) {
    throw new RangeError(`options.limit must be an integer from 0 to ${MAX_QUERY_HITS}`);
  }
  if (input.maxTokens !== undefined) positiveInteger(input.maxTokens, "maxTokens");
  if (input.pageSize !== undefined) positiveInteger(input.pageSize, "pageSize");
  if (input.pageSize !== undefined && input.pageSize > MAX_QUERY_HITS) {
    throw new RangeError(`pageSize must be an integer from 1 to ${MAX_QUERY_HITS}`);
  }
  if (input.pageToken !== undefined) requiredString(input.pageToken, "pageToken");
  const effectiveOptions = input.pageSize !== undefined && (options === undefined || options.limit === undefined)
    ? { ...(options ?? {}), limit: input.pageSize }
    : options;
  return {
    query: input.query,
    ...(effectiveOptions === undefined ? {} : { options: effectiveOptions }),
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
    ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
    ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken })
  };
}

function normalizeQueryResponse<T>(value: unknown): QueryResponse<T> {
  if (!isRecord(value) || !Array.isArray(value.hits)) throw new PremiseDecodeError("PREMiSE query response must contain a hits array");
  if (!isRecord(value.context) || !Array.isArray(value.context.selected)) {
    throw new PremiseDecodeError("PREMiSE query response must contain a context.selected array");
  }
  for (const hit of value.hits) {
    if (!isRecord(hit) || !isNonEmptyString(hit.id) || typeof hit.text !== "string" || typeof hit.score !== "number" || !Number.isFinite(hit.score)) {
      invalidResponse("PREMiSE query response contains an invalid hit", value);
    }
  }
  for (const selected of value.context.selected) {
    if (!isRecord(selected)) invalidResponse("PREMiSE query response context.selected must contain objects", value);
  }
  const context = value.context as ContextPlan;
  if (value.nextPageToken !== undefined && (typeof value.nextPageToken !== "string" || value.nextPageToken.length === 0)) {
    throw new PremiseDecodeError("PREMiSE query response nextPageToken must be a string");
  }
  if (value.page !== undefined && !isRecord(value.page)) {
    throw new PremiseDecodeError("PREMiSE query response page must be an object");
  }
  if (isRecord(value.page) && value.page.pageSize !== undefined && (typeof value.page.pageSize !== "number" || !Number.isSafeInteger(value.page.pageSize) || value.page.pageSize <= 0)) {
    throw new PremiseDecodeError("PREMiSE query response page.pageSize must be a positive integer");
  }
  if (isRecord(value.page) && value.page.nextPageToken !== undefined && (typeof value.page.nextPageToken !== "string" || value.page.nextPageToken.length === 0)) {
    throw new PremiseDecodeError("PREMiSE query response page.nextPageToken must be a string");
  }
  return {
    ...value,
    hits: value.hits as QueryHit<T>[],
    context,
    ...(value.nextPageToken === undefined ? {} : { nextPageToken: value.nextPageToken })
  } as QueryResponse<T>;
}

function invalidResponse(message: string, body: unknown): never {
  throw new PremiseSdkError(message, "INVALID_RESPONSE", { body });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function assertHealthResponse(value: unknown): asserts value is HealthResponse {
  assertApiSpecVersion(value, "PREMiSE health response");
  if (!isRecord(value) || typeof value.ok !== "boolean" || !isNonNegativeSafeInteger(value.memories) || !isNonNegativeSafeInteger(value.events)) {
    invalidResponse("PREMiSE health response must contain ok, memories and events", value);
  }
}

function assertCapabilitiesResponse(value: unknown): asserts value is CapabilitiesResponse {
  assertApiSpecVersion(value, "PREMiSE capabilities response");
  if (!isRecord(value) || !Array.isArray(value.capabilities) || value.capabilities.some((capability) => !isNonEmptyString(capability))) {
    invalidResponse("PREMiSE capabilities response must contain a capabilities string array", value);
  }
}

function assertStoreMemoryResponse(value: unknown): asserts value is StoreMemoryResponse {
  if (!isRecord(value) || !isNonEmptyString(value.memoryId) || !isNonEmptyString(value.status)) {
    invalidResponse("PREMiSE store response must contain memoryId and status", value);
  }
}

function assertVersionReference(value: unknown, label: string, body: unknown): asserts value is VersionReference {
  if (!isRecord(value) || !isNonEmptyString(value.scheme) || !isNonEmptyString(value.token)) {
    invalidResponse(`${label} must contain scheme and token`, body);
  }
}

function assertRevalidationReport(value: unknown): asserts value is RevalidationReport {
  if (!isRecord(value)
    || !isNonEmptyString(value.memoryId)
    || !["UNCHANGED", "CHANGED", "MISSING", "UNKNOWN"].includes(value.result as string)
    || !["FRESH", "STALE", "INVALID", "UNKNOWN"].includes(value.status as string)
    || typeof value.checkedAt !== "string"
    || Number.isNaN(Date.parse(value.checkedAt))) {
    invalidResponse("PREMiSE revalidation response is not a valid report", value);
  }
  if (value.sourceUri !== undefined && typeof value.sourceUri !== "string") invalidResponse("PREMiSE revalidation sourceUri must be a string", value);
  if (value.version !== undefined) assertVersionReference(value.version, "PREMiSE revalidation version", value);
}

function assertSourceChangedResponse(value: unknown): asserts value is SourceChangedResponse {
  if (!isRecord(value) || !Array.isArray(value.affected) || value.affected.some((memoryId) => !isNonEmptyString(memoryId))) {
    invalidResponse("PREMiSE source-changed response must contain an affected string array", value);
  }
  if (value.nextPageToken !== undefined && !isNonEmptyString(value.nextPageToken)) {
    invalidResponse("PREMiSE source-changed nextPageToken must be a non-empty string", value);
  }
}

function assertApiSpecVersion(value: unknown, label: string): void {
  if (!isRecord(value) || value.specVersion !== API_SPEC_VERSION) {
    throw new PremiseSdkError(`${label} must declare specVersion ${API_SPEC_VERSION}`, "INVALID_RESPONSE", { body: value });
  }
}

function assertMemoryRecordVersion(value: unknown, label = "PREMiSE memory response", code: PremiseErrorCode = "INVALID_RESPONSE"): asserts value is MemoryRecord<unknown> {
  if (!isRecord(value) || !isRecord(value.envelope) || value.envelope.specVersion !== API_SPEC_VERSION || !hasOwn(value, "content")) {
    throw new PremiseSdkError(`${label} must use specVersion ${API_SPEC_VERSION} and contain content`, code, { body: value });
  }
}

function retryAfterMilliseconds(error: PremiseHttpError, now: number): number | undefined {
  const value = error.responseHeaders["retry-after"];
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function retryableError(error: unknown): error is PremiseHttpError | PremiseTimeoutError | PremiseNetworkError {
  return error instanceof PremiseHttpError || error instanceof PremiseTimeoutError || error instanceof PremiseNetworkError;
}

export class PremiseClient<T = unknown> {
  readonly baseUrl: URL;
  readonly tenantId: string | undefined;
  readonly subjectId: string | undefined;
  private readonly authorization: AuthorizationProvider | undefined;
  private readonly defaultHeaders: Headers;
  private readonly timeoutMs: number;
  private readonly retry: ResolvedRetryOptions;
  private readonly fetchImplementation: FetchImplementation;
  private readonly sleep: SleepImplementation;
  private readonly random: () => number;
  private readonly logger: Logger;

  constructor(options: PremiseClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    if (options.requireHttps === true && this.baseUrl.protocol !== "https:") {
      throw new TypeError("baseUrl must use https when requireHttps is enabled");
    }
    this.tenantId = options.tenantId === undefined ? undefined : requiredString(options.tenantId, "tenantId");
    this.subjectId = options.subjectId === undefined ? undefined : requiredString(options.subjectId, "subjectId");
    if (options.token !== undefined && options.authorization !== undefined) throw new TypeError("Use token or authorization, not both");
    if (options.token !== undefined) requiredString(options.token, "token");
    this.authorization = options.token === undefined
      ? options.authorization
      : "Bearer " + options.token;
    this.defaultHeaders = new Headers(options.headers);
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.retry = resolveRetry(options.retry, options.maxRetries ?? options.retries);
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImplementation !== "function") throw new TypeError("A fetch implementation is required");
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? (() => undefined);
  }

  async health(options?: RequestOptions): Promise<HealthResponse> {
    const value = await this.request<unknown>("GET", "health", undefined, options);
    assertHealthResponse(value);
    return value as HealthResponse;
  }

  async capabilities(options?: RequestOptions): Promise<CapabilitiesResponse> {
    const value = await this.request<unknown>("GET", "v2/capabilities", undefined, options);
    assertCapabilitiesResponse(value);
    return value as CapabilitiesResponse;
  }

  async getMemory<TContent = T>(memoryId: string, options?: RequestOptions): Promise<MemoryRecord<TContent>> {
    const value = await this.request<unknown>("GET", "v2/memories/" + encodeURIComponent(requiredString(memoryId, "memoryId")), undefined, options);
    assertMemoryRecordVersion(value);
    return value as MemoryRecord<TContent>;
  }

  registerMemory(record: MemoryRecord<T>, options?: RequestOptions): Promise<StoreMemoryResponse> {
    this.assertRecordTenant(record);
    return this.request<unknown>("POST", "v2/memories", { record }, options).then((value) => {
      assertStoreMemoryResponse(value);
      return value;
    });
  }

  deriveMemory(record: MemoryRecord<T>, options?: RequestOptions): Promise<StoreMemoryResponse> {
    this.assertRecordTenant(record);
    return this.request<unknown>("POST", "v2/memories", { record, derived: true }, options).then((value) => {
      assertStoreMemoryResponse(value);
      return value;
    });
  }

  register(record: MemoryRecord<T>, options?: RequestOptions): Promise<StoreMemoryResponse> {
    return this.registerMemory(record, options);
  }

  derive(record: MemoryRecord<T>, options?: RequestOptions): Promise<StoreMemoryResponse> {
    return this.deriveMemory(record, options);
  }

  query(input: QueryRequest, options?: RequestOptions): Promise<QueryResponse<T>>;
  query(query: string, input?: QueryInputOptions | QuerySearchOptions, options?: RequestOptions): Promise<QueryResponse<T>>;
  async query(
    input: QueryRequest | string,
    second?: RequestOptions | QueryInputOptions | QuerySearchOptions,
    third?: RequestOptions
  ): Promise<QueryResponse<T>> {
    const normalized = normalizeQueryCall(input, second, third);
    const value = await this.request<unknown>("POST", "v2/query", queryBody(normalized.request), normalized.requestOptions);
    return normalizeQueryResponse<T>(value);
  }

  async *queryPages(
    input: QueryRequest | string,
    second?: RequestOptions | QueryInputOptions | QuerySearchOptions | QueryAllOptions,
    third?: RequestOptions | QueryAllOptions
  ): AsyncGenerator<QueryResponse<T>, void, undefined> {
    const normalized = normalizeQueryCall(input, second, third);
    const paginationOptions = normalized.requestOptions as QueryAllOptions | undefined;
    const maxPages = paginationOptions?.maxPages ?? 100;
    positiveInteger(maxPages, "maxPages");
    const seen = new Set<string>();
    let pageToken = normalized.request.pageToken;
    if (pageToken !== undefined) seen.add(pageToken);
    for (let page = 0; ; page += 1) {
      if (page >= maxPages) throw new PremisePaginationError("PREMiSE query pagination exceeded maxPages");
      const request = pageToken === undefined ? normalized.request : { ...normalized.request, pageToken };
      const response = await this.query(request, normalized.requestOptions);
      yield response;
      const nextPageToken = response.nextPageToken ?? response.page?.nextPageToken;
      if (nextPageToken === undefined || nextPageToken.length === 0) return;
      if (seen.has(nextPageToken)) throw new PremisePaginationError("PREMiSE query pagination repeated a page token");
      seen.add(nextPageToken);
      pageToken = nextPageToken;
    }
  }

  async queryAll(
    input: QueryRequest | string,
    second?: RequestOptions | QueryInputOptions | QuerySearchOptions | QueryAllOptions,
    third?: RequestOptions | QueryAllOptions
  ): Promise<readonly QueryHit<T>[]> {
    const hits: QueryHit<T>[] = [];
    for await (const response of this.queryPages(input, second, third)) hits.push(...response.hits);
    return hits;
  }

  async revalidate(memoryId: string, options?: RequestOptions): Promise<RevalidationReport> {
    const value = await this.request<unknown>(
      "POST",
      "v2/memories/" + encodeURIComponent(requiredString(memoryId, "memoryId")) + "/revalidate",
      undefined,
      options
    );
    assertRevalidationReport(value);
    return value;
  }

  revalidateMemory(memoryId: string, options?: RequestOptions): Promise<RevalidationReport> {
    return this.revalidate(memoryId, options);
  }

  sourceChanged(input: SourceChangedRequest, options?: RequestOptions): Promise<SourceChangedResponse>;
  sourceChanged(sourceUri: string, version: VersionReference, options?: RequestOptions): Promise<SourceChangedResponse>;
  sourceChanged(
    input: SourceChangedRequest | string,
    versionOrOptions?: VersionReference | RequestOptions,
    options?: RequestOptions
  ): Promise<SourceChangedResponse> {
    const request = typeof input === "string"
      ? { sourceUri: requiredString(input, "sourceUri"), version: versionOrOptions as VersionReference }
      : input;
    if (!isRecord(request)) throw new TypeError("sourceChanged input must be an object");
    requiredString(request.sourceUri, "sourceUri");
    if (!isRecord(request.version) || typeof request.version.scheme !== "string" || typeof request.version.token !== "string") {
      throw new TypeError("version must contain scheme and token strings");
    }
    requiredString(request.version.scheme, "version.scheme");
    requiredString(request.version.token, "version.token");
    const requestOptions = typeof input === "string" ? options : versionOrOptions as RequestOptions | undefined;
    return this.request<unknown>("POST", "v2/source-changed", request, requestOptions).then((value) => {
      assertSourceChangedResponse(value);
      return value;
    });
  }

  signalSourceChanged(input: SourceChangedRequest, options?: RequestOptions): Promise<SourceChangedResponse>;
  signalSourceChanged(sourceUri: string, version: VersionReference, options?: RequestOptions): Promise<SourceChangedResponse>;
  signalSourceChanged(
    input: SourceChangedRequest | string,
    versionOrOptions?: VersionReference | RequestOptions,
    options?: RequestOptions
  ): Promise<SourceChangedResponse> {
    return typeof input === "string"
      ? this.sourceChanged(input, versionOrOptions as VersionReference, options)
      : this.sourceChanged(input, versionOrOptions as RequestOptions | undefined);
  }

  private assertRecordTenant(record: MemoryRecord<T>): void {
    assertMemoryRecordVersion(record, "PREMiSE memory request", "INVALID_REQUEST");
    requiredString(record.envelope.memoryId, "record.envelope.memoryId");
    requiredString(record.envelope.tenantId, "record.envelope.tenantId");
    if (this.tenantId !== undefined && record.envelope.tenantId !== this.tenantId) {
      throw new TypeError("record.envelope.tenantId must match the client tenantId");
    }
  }

  private endpoint(path: string): URL {
    return new URL(path.replace(/^\/+/u, ""), this.baseUrl);
  }

  private async prepareRequest(
    method: string,
    body: unknown,
    options: RequestOptions | undefined
  ): Promise<PreparedRequest> {
    let serializedBody: string | undefined;
    if (body !== undefined) {
      try {
        serializedBody = JSON.stringify(body);
      } catch (cause) {
        throw new PremiseSdkError("Request body must be JSON serializable", "INVALID_REQUEST", { cause });
      }
      if (serializedBody === undefined) throw new PremiseSdkError("Request body must be JSON serializable", "INVALID_REQUEST");
    }

    const headers = new Headers(this.defaultHeaders);
    if (options?.headers !== undefined) new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (serializedBody !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");

    if (this.tenantId !== undefined) headers.set("x-premise-tenant", this.tenantId);
    if (this.subjectId !== undefined) headers.set("x-premise-subject", this.subjectId);
    if (!headers.has("authorization") && this.authorization !== undefined) {
      const authorization = typeof this.authorization === "function" ? await this.authorization() : this.authorization;
      if (authorization !== undefined) headers.set("authorization", requiredString(authorization, "authorization"));
    }

    const requestId = options?.requestId ?? headers.get("x-request-id") ?? makeRequestId();
    headers.set("x-request-id", visibleAscii(requestId, "requestId", 128));

    let idempotencyKey: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      idempotencyKey = options?.idempotencyKey ?? headers.get("idempotency-key") ?? makeIdempotencyKey();
      headers.set("idempotency-key", visibleAscii(idempotencyKey, "idempotencyKey", 256));
    }
    return { headers, body: serializedBody, idempotencyKey, requestId };
  }

  private async request<R>(
    method: "GET" | "POST" | "HEAD",
    path: string,
    body: unknown,
    options?: RequestOptions
  ): Promise<R> {
    const url = this.endpoint(path);
    const prepared = await this.prepareRequest(method, body, options);
    const timeoutMs = positiveInteger(options?.timeoutMs ?? this.timeoutMs, "timeoutMs");
    const retry = resolveRetry(options?.retry, options?.maxRetries ?? options?.retries, this.retry);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.sendOnce<R>(method, url, prepared, timeoutMs, options?.signal, attempt);
      } catch (error) {
        if (retryableError(error) && attempt < retry.maxRetries && this.safeToRetry(method, prepared.idempotencyKey) && (
          !(error instanceof PremiseHttpError) || (error.status !== undefined && retry.retryOn.has(error.status))
        )) {
          const delayMs = this.retryDelay(error, attempt, retry);
          this.log({
            type: "retry",
            method,
            url: redactUrl(url.toString()),
            attempt,
            code: error.code,
            delayMs,
            nextAttempt: attempt + 1
          });
          await this.sleep(delayMs);
          if (options?.signal?.aborted) throw new PremiseAbortError("PREMiSE request was aborted", prepared.requestId);
          continue;
        }
        const status = error instanceof PremiseSdkError ? error.status : undefined;
        const requestId = error instanceof PremiseSdkError ? error.requestId : undefined;
        this.log({
          type: "error",
          method,
          url: redactUrl(url.toString()),
          attempt,
          code: error instanceof PremiseSdkError ? error.code : "UNKNOWN",
          message: error instanceof Error ? error.message : String(error),
          ...(status === undefined ? {} : { status }),
          ...(requestId === undefined ? {} : { requestId })
        });
        throw error;
      }
    }
  }

  private async sendOnce<R>(
    method: "GET" | "POST" | "HEAD",
    url: URL,
    prepared: PreparedRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    attempt: number
  ): Promise<R> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) throw new PremiseAbortError("PREMiSE request was aborted", prepared.requestId);
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    this.log({
      type: "request",
      method,
      url: redactUrl(url.toString()),
      attempt,
      requestId: prepared.requestId,
      headers: redactHeaders(prepared.headers)
    });
    try {
      const init: RequestInit = {
        method,
        headers: prepared.headers,
        signal: controller.signal,
        ...(prepared.body === undefined ? {} : { body: prepared.body })
      };
      const response = await this.fetchImplementation(url, init);
      const headerRequestId = responseRequestId(response.headers);
      const requestId = headerRequestId ?? prepared.requestId;
      this.log({
        type: "response",
        method,
        url: redactUrl(url.toString()),
        attempt,
        status: response.status,
        ...(requestId === undefined ? {} : { requestId })
      });
      if (!response.ok) {
        const body = await responseBodyLenient(response);
        const description = errorDescription(response.status, body);
        const errorRequestId = headerRequestId ?? bodyRequestId(body) ?? prepared.requestId;
        throw new PremiseHttpError({
          ...description,
          status: response.status,
          method,
          url: url.toString(),
          responseHeaders: responseHeaders(response.headers),
          requestId: errorRequestId,
          body
        });
      }
      if (response.status === 204) return undefined as R;
      return await responseBody(response) as R;
    } catch (error) {
      if (error instanceof PremiseSdkError) throw error;
      if (timedOut) throw new PremiseTimeoutError("PREMiSE request timed out after " + timeoutMs + " ms", timeoutMs, prepared.requestId, error);
      if (signal?.aborted) throw new PremiseAbortError("PREMiSE request was aborted", prepared.requestId, error);
      throw new PremiseNetworkError("PREMiSE request failed before receiving a response", prepared.requestId, error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private safeToRetry(method: string, idempotencyKey: string | undefined): boolean {
    return method === "GET" || method === "HEAD" || idempotencyKey !== undefined;
  }

  private retryDelay(error: PremiseHttpError | PremiseTimeoutError | PremiseNetworkError, attempt: number, retry: ResolvedRetryOptions): number {
    const retryAfter = error instanceof PremiseHttpError ? retryAfterMilliseconds(error, Date.now()) : undefined;
    if (retryAfter !== undefined) return Math.min(retry.maxDelayMs, retryAfter);
    const exponential = Math.min(retry.maxDelayMs, retry.baseDelayMs * (2 ** attempt));
    const randomValue = Math.min(1, Math.max(0, this.random()));
    const factor = 1 + ((randomValue * 2) - 1) * retry.jitter;
    return Math.max(0, Math.min(retry.maxDelayMs, Math.round(exponential * factor)));
  }

  private log(event: SdkLogEvent): void {
    try {
      this.logger(event);
    } catch {
      // Logging must never turn a successful API call into a failed one.
    }
  }
}

export function createPremiseClient<T = unknown>(options: PremiseClientOptions): PremiseClient<T> {
  return new PremiseClient<T>(options);
}
