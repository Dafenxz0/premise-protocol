import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { ContextEngine, type ContextCandidate } from "@premise/context-engine";
import { HybridIndex, type SearchOptions } from "@premise/index-hybrid";
import { SPEC_VERSION_V2 } from "@premise/protocol-types";
import { PremiseRuntime, type RuntimePrincipal, type RuntimeRecord, type RuntimeValidator } from "@premise/runtime-core";

export interface PremiseServerOptions<T> {
  readonly runtime: PremiseRuntime<T>;
  readonly index?: HybridIndex;
  readonly context?: ContextEngine;
  readonly validator?: RuntimeValidator<T>;
  readonly principal?: RuntimePrincipal;
  readonly authorize?: (request: IncomingMessage, requested: RuntimePrincipal) => RuntimePrincipal | false | Promise<RuntimePrincipal | false>;
  readonly allowTenantHeader?: boolean;
  readonly maxBodyBytes?: number;
  readonly onMetric?: (metric: PremiseServerMetric) => void;
  readonly logger?: (message: string) => void;
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
  constructor(readonly status: number, readonly code: string, message: string) {
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

export interface ServerAddress {
  readonly host: string;
  readonly port: number;
}

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    const declaredLength = request.headers["content-length"];
    if (typeof declaredLength === "string" && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBodyBytes) {
      reject(new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the configured limit"));
      request.resume();
      return;
    }
    request.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      bytes += typeof chunk === "string" ? utf8Bytes(chunk) : chunk.byteLength;
      if (bytes > maxBodyBytes) {
        reject(new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the configured limit"));
        request.resume();
        return;
      }
      body += text;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function parseJson(body: string): Record<string, unknown> {
  if (body.length === 0) return {};
  const value: unknown = JSON.parse(body);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Request body must be a JSON object");
  return value as Record<string, unknown>;
}

function routeMemoryId(pathname: string): string | undefined {
  const match = /^\/v2\/memories\/([^/]+)$/u.exec(pathname);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function requestPrincipal(request: IncomingMessage, fallback: RuntimePrincipal, allowTenantHeader: boolean): RuntimePrincipal {
  const tenantHeader = request.headers["x-premise-tenant"];
  const subjectHeader = request.headers["x-premise-subject"];
  const tenantId = allowTenantHeader && typeof tenantHeader === "string" ? tenantHeader : fallback.tenantId;
  const subjectId = allowTenantHeader && typeof subjectHeader === "string" ? subjectHeader : fallback.subjectId;
  return { tenantId, ...(subjectId ? { subjectId } : {}), ...(fallback.roles ? { roles: fallback.roles } : {}) };
}

export class PremiseServer<T = unknown> {
  readonly server: Server;
  readonly runtime: PremiseRuntime<T>;
  readonly index: HybridIndex;
  readonly context: ContextEngine;
  private readonly validator: RuntimeValidator<T> | undefined;
  private readonly principal: RuntimePrincipal;
  private readonly authorize: PremiseServerOptions<T>["authorize"];
  private readonly allowTenantHeader: boolean;
  private readonly maxBodyBytes: number;
  private readonly onMetric: ((metric: PremiseServerMetric) => void) | undefined;
  private readonly logger: (message: string) => void;

  constructor(options: PremiseServerOptions<T>) {
    this.runtime = options.runtime;
    this.index = options.index ?? new HybridIndex();
    this.context = options.context ?? new ContextEngine();
    this.validator = options.validator;
    this.principal = options.principal ?? this.runtime.principal;
    this.authorize = options.authorize;
    this.allowTenantHeader = options.allowTenantHeader ?? false;
    this.maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes < 1) throw new TypeError("maxBodyBytes must be a positive safe integer");
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
      metricTenant = principal.tenantId;
      if (method === "GET" && url.pathname === "/health") {
        jsonResponse(response, 200, { ok: true, specVersion: SPEC_VERSION_V2, memories: this.runtime.list(principal).length, events: this.runtime.eventCount() });
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
        if (!record || typeof record !== "object") throw new Error("record is required");
        if (input.derived === true) this.runtime.derive(record); else this.runtime.register(record);
        await this.index.upsert(this.indexDocument(record));
        jsonResponse(response, 201, { memoryId: record.envelope.memoryId, status: "stored" });
        return;
      }
      if (method === "POST" && url.pathname === "/v2/query") {
        const input = parseJson(await readBody(request, this.maxBodyBytes));
        const query = typeof input.query === "string" ? input.query : "";
        const options = (input.options ?? {}) as SearchOptions;
        const hits = await this.index.search(query, { ...options, filter: { tenantId: principal.tenantId } });
        const candidates: ContextCandidate[] = [];
        for (const hit of hits) {
          const record = this.runtime.get(hit.id, principal);
          if (record === undefined) continue;
          const state = this.runtime.check([hit.id], principal)[0];
          if (state === undefined) continue;
          candidates.push({ id: hit.id, text: hit.text, score: hit.score, freshness: state.status, topic: record.envelope.evidence[0]?.sourceUri ?? hit.id, metadata: { tenantId: record.envelope.tenantId } });
        }
        const plan = this.context.select({ candidates, tokenBudget: typeof input.maxTokens === "number" ? input.maxTokens : 4_096 });
        jsonResponse(response, 200, { hits, context: plan });
        return;
      }
      if (method === "POST" && /^\/v2\/memories\/[^/]+\/revalidate$/u.test(url.pathname)) {
        if (this.validator === undefined) { jsonResponse(response, 501, { error: "No validator configured" }); return; }
        const id = routeMemoryId(url.pathname.replace(/\/revalidate$/u, ""));
        if (id === undefined) { jsonResponse(response, 404, { error: "memory not found" }); return; }
        jsonResponse(response, 200, await this.runtime.revalidate(id, this.validator));
        return;
      }
      if (method === "POST" && url.pathname === "/v2/source-changed") {
        const input = parseJson(await readBody(request, this.maxBodyBytes));
        if (typeof input.sourceUri !== "string" || typeof input.version !== "object" || input.version === null) throw new Error("sourceUri and version are required");
        jsonResponse(response, 202, { affected: this.runtime.signalSourceChanged(input.sourceUri, input.version as { scheme: string; token: string }) });
        return;
      }
      jsonResponse(response, 404, { error: "route not found" });
    } catch (error) {
      this.logger(error instanceof Error ? error.stack ?? error.message : String(error));
      const httpError = error instanceof HttpError ? error : error instanceof SyntaxError ? new HttpError(400, "INVALID_JSON", "Request body is not valid JSON") : error instanceof TypeError ? new HttpError(400, "INVALID_REQUEST", error.message) : new HttpError(500, "INTERNAL_ERROR", "Internal server error");
      jsonResponse(response, httpError.status, { error: httpError.code, message: httpError.message, requestId });
    } finally {
      this.onMetric?.({ requestId, method: (request.method ?? "GET").toUpperCase(), path: request.url ?? "/", status: response.statusCode, durationMs: Date.now() - startedAt, ...(metricTenant ? { tenantId: metricTenant } : {}) });
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
