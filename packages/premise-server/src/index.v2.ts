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
  readonly logger?: (message: string) => void;
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

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk); });
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

function requestPrincipal(request: IncomingMessage, fallback: RuntimePrincipal): RuntimePrincipal {
  const tenantHeader = request.headers["x-premise-tenant"];
  const subjectHeader = request.headers["x-premise-subject"];
  const tenantId = typeof tenantHeader === "string" ? tenantHeader : fallback.tenantId;
  const subjectId = typeof subjectHeader === "string" ? subjectHeader : fallback.subjectId;
  return { tenantId, ...(subjectId ? { subjectId } : {}), ...(fallback.roles ? { roles: fallback.roles } : {}) };
}

export class PremiseServer<T = unknown> {
  readonly server: Server;
  readonly runtime: PremiseRuntime<T>;
  readonly index: HybridIndex;
  readonly context: ContextEngine;
  private readonly validator: RuntimeValidator<T> | undefined;
  private readonly principal: RuntimePrincipal;
  private readonly logger: (message: string) => void;

  constructor(options: PremiseServerOptions<T>) {
    this.runtime = options.runtime;
    this.index = options.index ?? new HybridIndex();
    this.context = options.context ?? new ContextEngine();
    this.validator = options.validator;
    this.principal = options.principal ?? this.runtime.principal;
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
    try {
      const url = new URL(request.url ?? "/", "http://premise.local");
      const method = (request.method ?? "GET").toUpperCase();
      const principal = requestPrincipal(request, this.principal);
      if (method === "GET" && url.pathname === "/health") {
        jsonResponse(response, 200, { ok: true, specVersion: SPEC_VERSION_V2, memories: this.runtime.list(principal).length, events: this.runtime.history().length });
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
        const input = parseJson(await readBody(request));
        const record = input.record as RuntimeRecord<T>;
        if (!record || typeof record !== "object") throw new Error("record is required");
        if (input.derived === true) this.runtime.derive(record); else this.runtime.register(record);
        await this.index.upsert(this.indexDocument(record));
        jsonResponse(response, 201, { memoryId: record.envelope.memoryId, status: "stored" });
        return;
      }
      if (method === "POST" && url.pathname === "/v2/query") {
        const input = parseJson(await readBody(request));
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
        const input = parseJson(await readBody(request));
        if (typeof input.sourceUri !== "string" || typeof input.version !== "object" || input.version === null) throw new Error("sourceUri and version are required");
        jsonResponse(response, 202, { affected: this.runtime.signalSourceChanged(input.sourceUri, input.version as { scheme: string; token: string }) });
        return;
      }
      jsonResponse(response, 404, { error: "route not found" });
    } catch (error) {
      this.logger(error instanceof Error ? error.stack ?? error.message : String(error));
      jsonResponse(response, 400, { error: error instanceof Error ? error.message : String(error) });
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
