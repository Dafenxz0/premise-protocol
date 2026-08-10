import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { ContextEngine, type ContextCandidate } from "@premise/context-engine";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_CANDIDATE_LIMIT, MAX_SEARCH_LIMIT, HybridIndex, type HybridDocument, type MetadataFilter, type SearchOptions } from "@premise/index-hybrid";
import { SPEC_VERSION_V2, V2EnvelopeValidationError } from "@premise/protocol-types";
import { PremiseRuntime, type RuntimePrincipal, type RuntimeRecord, type RuntimeValidator } from "@premise/runtime-core";

export const HTTP_IDEMPOTENCY_PROTOCOL = "premise-http-idempotency/1" as const;
export const HTTP_REQUEST_HASH_PREFIX = "sha256:http-v1:" as const;

export interface PremiseSearchHit<T = unknown> {
  readonly id: string;
  readonly text: string;
  readonly score: number;
  readonly content?: T;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly record?: RuntimeRecord<T>;
}

/** JSON-safe query options accepted by POST /v2/query. */
export interface PremiseQueryOptions<T = unknown> extends Omit<SearchOptions<T>, "filter" | "filters"> {
  readonly filter?: MetadataFilter;
  readonly filters?: MetadataFilter;
}

/** JSON request body accepted by POST /v2/query. */
export interface PremiseQueryRequest<T = unknown> {
  readonly query: string;
  readonly options?: PremiseQueryOptions<T>;
  readonly maxTokens?: number;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export type PremiseQueryErrorCode =
  | "INVALID_JSON"
  | "INVALID_REQUEST"
  | "INVALID_QUERY_LIMIT"
  | "INVALID_QUERY_CANDIDATE_LIMIT"
  | "INVALID_QUERY_PAGE_SIZE"
  | "PAGINATION_UNSUPPORTED"
  | "UNAUTHORIZED"
  | "PERSISTENCE_BACKPRESSURE"
  | "INTERNAL_ERROR";

export interface PremiseQueryError {
  readonly error: PremiseQueryErrorCode;
  readonly message: string;
  readonly requestId: string;
  readonly details?: readonly unknown[];
}

export interface PremiseSearchIndex<T = unknown> {
  upsert(document: HybridDocument<T>): void | Promise<void>;
  search(query: string, options: SearchOptions<T>): Promise<readonly PremiseSearchHit<T>[]>;
}

export interface PremiseRuntimeCounts {
  readonly memories: number;
  readonly events: number;
}

export interface PremiseServerOptions<T> {
  readonly runtime: PremiseRuntime<T>;
  readonly index?: PremiseSearchIndex<T>;
  readonly runtimeCounts?: (principal: RuntimePrincipal) => PremiseRuntimeCounts | Promise<PremiseRuntimeCounts>;
  readonly context?: ContextEngine;
  readonly validator?: RuntimeValidator<T>;
  readonly principal?: RuntimePrincipal;
  readonly authorize?: (request: IncomingMessage, requested: RuntimePrincipal) => RuntimePrincipal | false | Promise<RuntimePrincipal | false>;
  readonly idempotencyStore?: HttpIdempotencyStore;
  readonly awaitDurability?: () => void | Promise<void>;
  readonly allowTenantHeader?: boolean;
  readonly maxBodyBytes?: number;
  readonly maxQueryHits?: number;
  readonly onMetric?: (metric: PremiseServerMetric) => void;
  readonly logger?: (message: string) => void;
}

export interface HttpIdempotencyRequest {
  readonly tenantId: string;
  readonly operation: string;
  readonly key: string;
  readonly requestHash: string;
}

export interface HttpIdempotencyResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type HttpIdempotencyClaim =
  | { readonly kind: "new"; readonly token: string }
  | { readonly kind: "replay"; readonly response: HttpIdempotencyResponse }
  | { readonly kind: "conflict" }
  | { readonly kind: "in-progress" };

export interface HttpIdempotencyCompletion extends HttpIdempotencyRequest {
  readonly token: string;
  readonly response: HttpIdempotencyResponse;
}

export interface HttpIdempotencyRelease extends HttpIdempotencyRequest {
  readonly token: string;
}

export interface HttpIdempotencyStore {
  claimHttpIdempotency(input: HttpIdempotencyRequest): HttpIdempotencyClaim | Promise<HttpIdempotencyClaim>;
  completeHttpIdempotency(input: HttpIdempotencyCompletion): void | Promise<void>;
  releaseHttpIdempotency(input: HttpIdempotencyRelease): void | Promise<void>;
}

class InMemoryHttpIdempotencyStore implements HttpIdempotencyStore {
  private readonly completed = new Map<string, { readonly requestHash: string; readonly response: HttpIdempotencyResponse }>();
  private readonly active = new Map<string, { readonly requestHash: string; readonly token: string }>();

  claimHttpIdempotency(input: HttpIdempotencyRequest): HttpIdempotencyClaim {
    const scope = this.scope(input);
    const completed = this.completed.get(scope);
    if (completed !== undefined) return completed.requestHash === input.requestHash ? { kind: "replay", response: completed.response } : { kind: "conflict" };
    const active = this.active.get(scope);
    if (active !== undefined) {
      if (active.requestHash !== input.requestHash) return { kind: "conflict" };
      return { kind: "in-progress" };
    }
    const token = randomUUID();
    this.active.set(scope, { requestHash: input.requestHash, token });
    return { kind: "new", token };
  }

  completeHttpIdempotency(input: HttpIdempotencyCompletion): void {
    const scope = this.scope(input);
    const active = this.active.get(scope);
    if (active === undefined || active.token !== input.token || active.requestHash !== input.requestHash) throw new Error(`Idempotency claim is no longer owned: ${input.key}`);
    this.completed.set(scope, { requestHash: input.requestHash, response: cloneJson(input.response) });
    this.active.delete(scope);
  }

  releaseHttpIdempotency(input: HttpIdempotencyRelease): void {
    const scope = this.scope(input);
    const active = this.active.get(scope);
    if (active?.token === input.token && active.requestHash === input.requestHash) this.active.delete(scope);
  }

  private scope(input: Pick<HttpIdempotencyRequest, "tenantId" | "operation" | "key">): string {
    return `${input.tenantId}\u0000${input.operation}\u0000${input.key}`;
  }
}

export interface PremiseServerMetric {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly tenantId?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
    readonly details?: readonly unknown[]
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("PREMiSE HTTP values must be JSON serializable");
  return JSON.parse(serialized) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredInputString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new RangeError(`${label} must be a positive safe integer`);
  return value as number;
}

function queryInteger(value: unknown, label: string, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new HttpError(400, code, `${label} must be a safe integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function runtimeCounts(value: PremiseRuntimeCounts): PremiseRuntimeCounts {
  if (value === null || typeof value !== "object" || !Number.isSafeInteger(value.memories) || value.memories < 0 || !Number.isSafeInteger(value.events) || value.events < 0) {
    throw new TypeError("runtimeCounts must return non-negative safe integer counts");
  }
  return value;
}

export interface ServerAddress {
  readonly host: string;
  readonly port: number;
}

function jsonResponse(response: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  response.statusCode = status;
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let settled = false;
    const decoder = new TextDecoder();
    const declaredLength = request.headers["content-length"];
    if (typeof declaredLength === "string" && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBodyBytes) {
      reject(new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the configured limit"));
      request.resume();
      return;
    }
    request.on("data", (chunk) => {
      if (settled) return;
      const text = typeof chunk === "string" ? chunk : "";
      bytes += typeof chunk === "string" ? utf8Bytes(chunk) : chunk.byteLength;
      if (bytes > maxBodyBytes) {
        settled = true;
        reject(new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the configured limit"));
        request.resume();
        return;
      }
      body += typeof chunk === "string" ? text : decoder.decode(chunk, { stream: true });
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      body += decoder.decode();
      resolve(body);
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function parseJson(body: string): Record<string, unknown> {
  if (body.length === 0) throw new TypeError("Request body is required");
  const value: unknown = JSON.parse(body);
  if (!isRecord(value)) throw new TypeError("Request body must be a JSON object");
  return value as Record<string, unknown>;
}

function routeMemoryId(pathname: string): string | undefined {
  const match = /^\/v2\/memories\/([^/]+)$/u.exec(pathname);
  if (match?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new HttpError(400, "INVALID_MEMORY_ID", "memoryId is not valid URL encoding");
  }
}

function requestPrincipal(request: IncomingMessage, fallback: RuntimePrincipal, allowTenantHeader: boolean): RuntimePrincipal {
  const tenantHeader = request.headers["x-premise-tenant"];
  const subjectHeader = request.headers["x-premise-subject"];
  const tenantId = allowTenantHeader && typeof tenantHeader === "string" ? tenantHeader : fallback.tenantId;
  const subjectId = allowTenantHeader && typeof subjectHeader === "string" ? subjectHeader : fallback.subjectId;
  return { tenantId, ...(subjectId ? { subjectId } : {}), ...(fallback.roles ? { roles: fallback.roles } : {}) };
}

function requestIdempotencyKey(request: IncomingMessage): string | undefined {
  const value = request.headers["idempotency-key"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,256}$/u.test(value)) throw new HttpError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 1-256 visible ASCII characters");
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Request values must be JSON serializable");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new TypeError("Request values must be JSON serializable");
}

function requestHash(operation: string, pathname: string, principal: RuntimePrincipal, payload: unknown): string {
  const canonical = canonicalJson({
    protocol: HTTP_IDEMPOTENCY_PROTOCOL,
    operation,
    pathname,
    tenantId: principal.tenantId,
    subjectId: principal.subjectId ?? null,
    roles: principal.roles ?? [],
    payload
  });
  return `${HTTP_REQUEST_HASH_PREFIX}${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export class PremiseServer<T = unknown> {
  readonly server: Server;
  readonly runtime: PremiseRuntime<T>;
  readonly index: PremiseSearchIndex<T>;
  readonly context: ContextEngine;
  private readonly validator: RuntimeValidator<T> | undefined;
  private readonly principal: RuntimePrincipal;
  private readonly authorize: PremiseServerOptions<T>["authorize"];
  private readonly runtimeCounts: PremiseServerOptions<T>["runtimeCounts"];
  private readonly idempotencyStore: HttpIdempotencyStore;
  private readonly awaitDurability: (() => void | Promise<void>) | undefined;
  private readonly allowTenantHeader: boolean;
  private readonly maxBodyBytes: number;
  private readonly maxQueryHits: number;
  private readonly onMetric: ((metric: PremiseServerMetric) => void) | undefined;
  private readonly logger: (message: string) => void;

  constructor(options: PremiseServerOptions<T>) {
    this.runtime = options.runtime;
    this.index = options.index ?? new HybridIndex<T>();
    this.context = options.context ?? new ContextEngine();
    this.validator = options.validator;
    this.principal = options.principal ?? this.runtime.principal;
    this.authorize = options.authorize;
    this.runtimeCounts = options.runtimeCounts;
    this.idempotencyStore = options.idempotencyStore ?? new InMemoryHttpIdempotencyStore();
    this.awaitDurability = options.awaitDurability;
    this.allowTenantHeader = options.allowTenantHeader ?? false;
    this.maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes < 1) throw new TypeError("maxBodyBytes must be a positive safe integer");
    this.maxQueryHits = options.maxQueryHits ?? 1_000;
    if (!Number.isSafeInteger(this.maxQueryHits) || this.maxQueryHits < 1 || this.maxQueryHits > MAX_SEARCH_LIMIT) {
      throw new TypeError(`maxQueryHits must be a safe integer from 1 to ${MAX_SEARCH_LIMIT}`);
    }
    this.onMetric = options.onMetric;
    this.logger = options.logger ?? (() => undefined);
    this.server = createServer((request, response) => { void this.handle(request, response); });
  }

  listen(address: ServerAddress): Promise<void> {
    return new Promise((resolve) => this.server.listen(address.port, address.host, resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const requestIdHeader = request.headers["x-request-id"];
    const requestId = typeof requestIdHeader === "string" && /^[\x21-\x7e]{1,128}$/u.test(requestIdHeader) ? requestIdHeader : randomUUID();
    response.setHeader("x-request-id", requestId);
    let metricTenant: string | undefined;
    try {
      const url = new URL(request.url ?? "/", "http://premise.local");
      const method = (request.method ?? "GET").toUpperCase();
      const requestedPrincipal = requestPrincipal(request, this.principal, this.allowTenantHeader);
      const principal = this.authorize === undefined ? requestedPrincipal : await this.authorize(request, requestedPrincipal);
      if (principal === false) throw new HttpError(401, "UNAUTHORIZED", "Request is not authorized");
      const idempotencyKey = method === "POST" ? requestIdempotencyKey(request) : undefined;
      metricTenant = principal.tenantId;
      if (method === "GET" && url.pathname === "/health") {
        const counts = this.runtimeCounts === undefined
          ? { memories: this.runtime.list(principal).length, events: this.runtime.eventCount() }
          : runtimeCounts(await this.runtimeCounts(principal));
        jsonResponse(response, 200, { ok: true, specVersion: SPEC_VERSION_V2, ...counts });
        return;
      }
      if (method === "GET" && url.pathname === "/v2/capabilities") {
        jsonResponse(response, 200, { specVersion: SPEC_VERSION_V2, capabilities: ["RECORD", "EVIDENCE", "DEPENDENCY_GRAPH", "CONFLICTS", "TEMPORAL_VALIDITY", "TRANSACTIONS", "IDEMPOTENT_EVENTS", "TENANCY", "RETRIEVAL", "CONTEXT_PACKING"] });
        return;
      }
      const memoryId = routeMemoryId(url.pathname);
      if (method === "GET" && memoryId !== undefined) {
        const record = this.runtime.get(memoryId, principal);
        if (record === undefined) { jsonResponse(response, 404, { error: "memory not found" }); return; }
        jsonResponse(response, 200, record);
        return;
      }
      if (method === "POST" && url.pathname === "/v2/memories") {
        const input = parseJson(await readBody(request, this.maxBodyBytes));
        const record = input.record as RuntimeRecord<T>;
        if (!isRecord(record)) throw new TypeError("record is required");
        const operation = input.derived === true ? "derive" : "register";
        const result = await this.executeMutation({
          idempotencyKey,
          operation,
          pathname: url.pathname,
          principal,
          payload: { record, derived: input.derived === true },
          action: async () => {
            if (input.derived === true) this.runtime.derive(record, idempotencyKey); else this.runtime.register(record, idempotencyKey);
            await this.index.upsert(this.indexDocument(record));
            return { status: 201, body: { memoryId: record.envelope.memoryId, status: "stored" } };
          }
        });
        jsonResponse(response, result.status, result.body, result.headers);
        return;
      }
      if (method === "POST" && url.pathname === "/v2/query") {
        const input = parseJson(await readBody(request, this.maxBodyBytes));
        const query = requiredInputString(input.query, "query");
        if (input.options !== undefined && !isRecord(input.options)) throw new TypeError("options must be an object");
        const options = input.options ?? {};
        if (options.filter !== undefined && options.filters !== undefined) throw new TypeError("Use either options.filter or options.filters, not both");
        const requestedFilter = options.filter ?? options.filters;
        if (requestedFilter !== undefined && !isRecord(requestedFilter)) throw new TypeError("options.filter must be an object");
        let limit: number | undefined;
        if (options.limit !== undefined) limit = queryInteger(options.limit, "options.limit", 0, this.maxQueryHits, "INVALID_QUERY_LIMIT");
        let pageSize: number | undefined;
        if (input.pageSize !== undefined) pageSize = queryInteger(input.pageSize, "pageSize", 1, this.maxQueryHits, "INVALID_QUERY_PAGE_SIZE");
        const effectiveLimit = limit ?? pageSize ?? DEFAULT_SEARCH_LIMIT;
        if (options.candidateLimit !== undefined) {
          const minimumCandidateLimit = Math.max(1, effectiveLimit);
          if (minimumCandidateLimit > MAX_SEARCH_CANDIDATE_LIMIT) {
            throw new HttpError(400, "INVALID_QUERY_CANDIDATE_LIMIT", `options.candidateLimit cannot satisfy an effective result limit of ${effectiveLimit}`);
          }
          queryInteger(options.candidateLimit, "options.candidateLimit", minimumCandidateLimit, MAX_SEARCH_CANDIDATE_LIMIT, "INVALID_QUERY_CANDIDATE_LIMIT");
        }
        if (input.pageToken !== undefined) throw new HttpError(501, "PAGINATION_UNSUPPORTED", "This PREMiSE server does not support pageToken yet");
        const { filter, filters, ...searchOptions } = options;
        const scopedOptions = {
          ...searchOptions,
          ...(pageSize === undefined || limit !== undefined ? {} : { limit: pageSize }),
          filter: { ...(requestedFilter as Record<string, unknown> | undefined), tenantId: principal.tenantId }
        } as unknown as SearchOptions;
        const hits = await this.index.search(query, scopedOptions);
        const candidates: ContextCandidate[] = [];
        for (const hit of hits) {
          const record = hit.record ?? this.runtime.get(hit.id, principal);
          if (record === undefined) continue;
          if (record.envelope.memoryId !== hit.id || record.envelope.tenantId !== principal.tenantId) continue;
          candidates.push({ id: hit.id, text: hit.text, score: hit.score, freshness: record.envelope.validity.status, topic: record.envelope.evidence[0]?.sourceUri ?? hit.id, metadata: { tenantId: record.envelope.tenantId } });
        }
        const tokenBudget = input.maxTokens === undefined ? 4_096 : positiveSafeInteger(input.maxTokens, "maxTokens");
        const plan = this.context.select({ candidates, tokenBudget });
        jsonResponse(response, 200, { hits, context: plan });
        return;
      }
      if (method === "POST" && /^\/v2\/memories\/[^/]+\/revalidate$/u.test(url.pathname)) {
        if (this.validator === undefined) { jsonResponse(response, 501, { error: "No validator configured" }); return; }
        const id = routeMemoryId(url.pathname.replace(/\/revalidate$/u, ""));
        if (id === undefined) { jsonResponse(response, 404, { error: "memory not found" }); return; }
        if (this.runtime.get(id, principal) === undefined) { jsonResponse(response, 404, { error: "memory not found" }); return; }
        const result = await this.executeMutation({
          idempotencyKey,
          operation: "revalidate",
          pathname: url.pathname,
          principal,
          payload: { memoryId: id },
          action: async () => ({ status: 200, body: await this.runtime.revalidate(id, this.validator!, idempotencyKey) })
        });
        jsonResponse(response, result.status, result.body, result.headers);
        return;
      }
      if (method === "POST" && url.pathname === "/v2/source-changed") {
        const input = parseJson(await readBody(request, this.maxBodyBytes));
        const sourceUri = requiredInputString(input.sourceUri, "sourceUri");
        if (!isRecord(input.version)) throw new TypeError("version must be an object");
        const version = {
          scheme: requiredInputString(input.version.scheme, "version.scheme"),
          token: requiredInputString(input.version.token, "version.token")
        };
        const result = await this.executeMutation({
          idempotencyKey,
          operation: "source-changed",
          pathname: url.pathname,
          principal,
          payload: { sourceUri, version },
          action: async () => ({ status: 202, body: { affected: this.runtime.signalSourceChanged(sourceUri, version, idempotencyKey) } })
        });
        jsonResponse(response, result.status, result.body, result.headers);
        return;
      }
      jsonResponse(response, 404, { error: "route not found" });
    } catch (error) {
      this.logger(error instanceof Error ? error.stack ?? error.message : String(error));
      const httpError = error instanceof HttpError
        ? error
        : error instanceof SyntaxError
          ? new HttpError(400, "INVALID_JSON", "Request body is not valid JSON")
          : error instanceof V2EnvelopeValidationError
            ? new HttpError(422, "VALIDATION_ERROR", error.message, {}, error.issues)
            : error instanceof Error && (error as Error & { readonly code?: unknown }).code === "PERSISTENCE_BACKPRESSURE"
              ? new HttpError(503, "PERSISTENCE_BACKPRESSURE", "Durable persistence is temporarily saturated", { "retry-after": "1" })
              : error instanceof Error && /Conflicting idempotency key/u.test(error.message)
                ? new HttpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was reused with a different request")
                : error instanceof Error && /Memory already registered/u.test(error.message)
                  ? new HttpError(409, "MEMORY_ALREADY_EXISTS", "The memory already exists")
                  : error instanceof Error && /Missing required dependency/u.test(error.message)
                    ? new HttpError(422, "MISSING_DEPENDENCY", "A required dependency is not available")
                    : error instanceof Error && /Memory not found or inaccessible/u.test(error.message)
                      ? new HttpError(404, "MEMORY_NOT_FOUND", "Memory not found")
                      : error instanceof Error && /Tenant boundary violation/u.test(error.message)
                        ? new HttpError(403, "TENANT_FORBIDDEN", "The memory belongs to another tenant")
                        : error instanceof TypeError || error instanceof RangeError || error instanceof URIError
                          ? new HttpError(400, "INVALID_REQUEST", error.message)
                          : new HttpError(500, "INTERNAL_ERROR", "Internal server error");
      jsonResponse(
        response,
        httpError.status,
        {
          error: httpError.code,
          message: httpError.message,
          requestId,
          ...(httpError.details === undefined ? {} : { details: httpError.details })
        },
        httpError.headers
      );
    } finally {
      this.onMetric?.({ requestId, method: (request.method ?? "GET").toUpperCase(), path: request.url ?? "/", status: response.statusCode, durationMs: Date.now() - startedAt, ...(metricTenant ? { tenantId: metricTenant } : {}) });
    }
  }

  private async executeMutation(input: {
    readonly idempotencyKey: string | undefined;
    readonly operation: string;
    readonly pathname: string;
    readonly principal: RuntimePrincipal;
    readonly payload: unknown;
    readonly action: () => Promise<HttpIdempotencyResponse>;
  }): Promise<HttpIdempotencyResponse> {
    if (input.idempotencyKey === undefined) return input.action();
    const request: HttpIdempotencyRequest = {
      tenantId: input.principal.tenantId,
      operation: input.operation,
      key: input.idempotencyKey,
      requestHash: requestHash(input.operation, input.pathname, input.principal, input.payload)
    };
    const claim = await this.idempotencyStore.claimHttpIdempotency(request);
    if (claim.kind === "replay") return claim.response;
    if (claim.kind === "conflict") throw new HttpError(409, "IDEMPOTENCY_CONFLICT", `Idempotency-Key already belongs to another request: ${input.idempotencyKey}`);
    if (claim.kind === "in-progress") throw new HttpError(425, "IDEMPOTENCY_IN_PROGRESS", "The same idempotent request is already in progress", { "retry-after": "1" });
    try {
      const result = await input.action();
      await this.awaitDurability?.();
      await this.idempotencyStore.completeHttpIdempotency({ ...request, token: claim.token, response: cloneJson(result) });
      return result;
    } catch (error) {
      try {
        await this.idempotencyStore.releaseHttpIdempotency({ ...request, token: claim.token });
      } catch (releaseError) {
        this.logger(`Failed to release idempotency claim ${input.idempotencyKey}: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`);
      }
      throw error;
    }
  }

  private indexDocument(record: RuntimeRecord<T>): { readonly id: string; readonly text: string; readonly content: T; readonly metadata: { readonly tenantId: string } } {
    const content = typeof record.content === "string" ? record.content : JSON.stringify(record.content) ?? String(record.content);
    return { id: record.envelope.memoryId, text: content, content: record.content, metadata: { tenantId: record.envelope.tenantId } };
  }
}

export function createPremiseServer<T>(options: PremiseServerOptions<T>): PremiseServer<T> {
  return new PremiseServer(options);
}
