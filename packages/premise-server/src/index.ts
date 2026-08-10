import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  EnvelopeValidationError,
  isValidationResult,
  validateMemoryEnvelope,
  type MemoryEnvelope,
  type MemoryStatus,
  type PremiseEvent,
  type SourceReference,
  type UsabilityDecision,
  type ValidationIssue,
  type ValidationResult
} from "@premise/protocol-types";
import {
  PremiseEventValidationError,
  ReferenceProtocol,
  validatePremiseEvent
} from "@premise/reference-ts";

export const DEFAULT_MAX_BODY_BYTES = 1_048_576;
export const SERVER_SPEC_VERSION = "premise/0.1" as const;

type Awaitable<T> = T | Promise<T>;
type JsonRecord = Record<string, unknown>;

export interface StoredMemory<T = unknown> {
  readonly memoryId: string;
  readonly envelope: MemoryEnvelope;
  readonly content?: T;
}

export interface MemoryStore {
  get(tenantId: string, memoryId: string): Awaitable<StoredMemory | undefined>;
  put(tenantId: string, memory: StoredMemory): Awaitable<void>;
}

export type Store = MemoryStore;

export interface CheckItem {
  readonly memoryId: string;
  readonly status: MemoryStatus;
  readonly decision: UsabilityDecision;
}

export interface SignalReport {
  readonly roots: readonly string[];
  readonly affected: readonly string[];
  readonly statuses: Readonly<Record<string, MemoryStatus>>;
}

export interface ValidationReportItem {
  readonly memoryId: string;
  readonly result: ValidationResult["result"];
  readonly previousStatus: MemoryStatus;
  readonly status: MemoryStatus;
  readonly version?: ValidationResult["version"];
}

export interface ValidationReport {
  readonly items: readonly ValidationReportItem[];
  readonly eventIds: readonly string[];
}

export interface PremiseIndex {
  register(tenantId: string, envelope: MemoryEnvelope): Awaitable<void>;
  derive(tenantId: string, envelope: MemoryEnvelope): Awaitable<void>;
  signal(tenantId: string, event: PremiseEvent & { readonly type: "SourceChanged" }): Awaitable<SignalReport>;
  check(tenantId: string, memoryIds: readonly string[]): Awaitable<readonly CheckItem[]>;
  validate(
    tenantId: string,
    memoryIds: readonly string[],
    suppliedResults?: Readonly<Record<string, ValidationResult>>
  ): Awaitable<ValidationReport>;
}

export type Index = PremiseIndex;

export interface Validator {
  readonly id: string;
  validate(source: SourceReference & { readonly memoryId?: string }): Awaitable<ValidationResult>;
}

export interface TenantPrincipal {
  readonly tenantId: string;
  readonly subject?: string;
}

export interface AuthorizationContext {
  readonly request: IncomingMessage;
  readonly requestId: string;
  readonly operation: Operation;
  readonly body: unknown;
}

export type TenantAuthorizer = (
  context: AuthorizationContext
) => Awaitable<TenantPrincipal | string | true | false | null | undefined>;

export interface PremiseServerOptions {
  readonly store?: MemoryStore;
  readonly index?: PremiseIndex;
  readonly validators?: readonly Validator[];
  readonly validator?: Validator;
  readonly authorize?: TenantAuthorizer;
  readonly authorizeTenant?: TenantAuthorizer;
  readonly tenantAuthorizer?: TenantAuthorizer;
  readonly maxBodyBytes?: number;
  readonly requestId?: () => string;
  readonly now?: () => string;
}

export type Operation = "register" | "derive" | "signal" | "check" | "validate" | "retrieve" | "health";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: readonly unknown[] | undefined;

  constructor(status: number, code: string, message: string, details?: readonly unknown[]) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class InMemoryStore implements MemoryStore {
  private readonly tenants = new Map<string, Map<string, StoredMemory>>();

  get(tenantId: string, memoryId: string): StoredMemory | undefined {
    const memory = this.tenants.get(tenantId)?.get(memoryId);
    return memory === undefined ? undefined : cloneJson(memory);
  }

  put(tenantId: string, memory: StoredMemory): void {
    if (memory.memoryId !== memory.envelope.memoryId) throw new TypeError("Memory record and envelope IDs must match");
    const memories = this.tenants.get(tenantId) ?? new Map<string, StoredMemory>();
    memories.set(memory.memoryId, cloneJson(memory));
    this.tenants.set(tenantId, memories);
  }
}

export class InMemoryIndex implements PremiseIndex {
  private readonly protocols = new Map<string, ReferenceProtocol>();
  private readonly validators: Validator[];

  constructor(validators: readonly Validator[] = [], private readonly now: () => string = () => new Date().toISOString()) {
    this.validators = [...validators];
  }

  registerValidator(validator: Validator): void {
    this.validators.push(validator);
    for (const protocol of this.protocols.values()) protocol.registerValidator(validator);
  }

  register(tenantId: string, envelope: MemoryEnvelope): void {
    this.protocolFor(tenantId).register(envelope);
  }

  derive(tenantId: string, envelope: MemoryEnvelope): void {
    this.protocolFor(tenantId).derive(envelope);
  }

  signal(tenantId: string, event: PremiseEvent & { readonly type: "SourceChanged" }): SignalReport {
    return this.protocolFor(tenantId).signal(event);
  }

  check(tenantId: string, memoryIds: readonly string[]): readonly CheckItem[] {
    return this.protocolFor(tenantId).check(memoryIds).items;
  }

  validate(
    tenantId: string,
    memoryIds: readonly string[],
    suppliedResults?: Readonly<Record<string, ValidationResult>>
  ): Promise<ValidationReport> {
    return this.protocolFor(tenantId).validate(memoryIds, suppliedResults);
  }

  private protocolFor(tenantId: string): ReferenceProtocol {
    const existing = this.protocols.get(tenantId);
    if (existing !== undefined) return existing;
    const protocol = new ReferenceProtocol(this.now);
    for (const validator of this.validators) protocol.registerValidator(validator);
    this.protocols.set(tenantId, protocol);
    return protocol;
  }
}

export function createServer(options: PremiseServerOptions = {}): Server {
  const store = options.store ?? new InMemoryStore();
  const validators = [
    ...(options.validators ?? []),
    ...(options.validator === undefined ? [] : [options.validator])
  ];
  const index = options.index ?? new InMemoryIndex(validators, options.now);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new TypeError("maxBodyBytes must be a positive safe integer");
  const authorize = options.tenantAuthorizer ?? options.authorizeTenant ?? options.authorize ?? defaultAuthorize;
  const requestId = options.requestId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  return createHttpServer((request, response) => {
    void handleRequest({ request, response, store, index, authorize, maxBodyBytes, requestId, now });
  });
}

export async function listen(
  options: PremiseServerOptions = {},
  port = 3000,
  hostname = "127.0.0.1"
): Promise<Server> {
  const server = createServer(options);
  await new Promise<void>((resolve, reject) => {
    server.on("error", (error) => reject(error));
    server.listen(port, hostname, resolve);
  });
  return server;
}

interface RequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly store: MemoryStore;
  readonly index: PremiseIndex;
  readonly authorize: TenantAuthorizer;
  readonly maxBodyBytes: number;
  readonly requestId: () => string;
  readonly now: () => string;
}

async function handleRequest(context: RequestContext): Promise<void> {
  const { request, response } = context;
  const id = getRequestId(request, context.requestId);
  response.setHeader("x-request-id", id);
  response.setHeader("request-id", id);

  try {
    const route = routeFor(request.url);
    if (route === undefined) throw new HttpError(404, "NOT_FOUND", "Route not found");
    if (route.operation === "health") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Health only supports GET");
      }
      sendJson(response, 200, { ok: true, status: "ok", operation: "health" }, id);
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      throw new HttpError(405, "METHOD_NOT_ALLOWED", `${route.operation} only supports POST`);
    }

    const body = await readJsonBody(request, context.maxBodyBytes);
    const tenant = await resolveTenant(context.authorize, {
      request,
      requestId: id,
      operation: route.operation,
      body
    });
    const result = await executeOperation(route.operation, body, tenant, context, id);
    sendJson(response, result.status, result.body, id);
  } catch (error) {
    sendError(response, error, id);
  }
}

interface OperationResult {
  readonly status: number;
  readonly body: JsonRecord;
}

async function executeOperation(
  operation: Exclude<Operation, "health">,
  body: unknown,
  tenantId: string,
  context: RequestContext,
  requestId: string
): Promise<OperationResult> {
  switch (operation) {
    case "register":
    case "derive": {
      const memory = parseMemory(body, operation);
      if (operation === "register") await context.index.register(tenantId, memory.envelope);
      else await context.index.derive(tenantId, memory.envelope);
      await context.store.put(tenantId, memory);
      return {
        status: 201,
        body: { ok: true, accepted: true, operation, memoryId: memory.memoryId }
      };
    }
    case "signal": {
      const event = parseSignal(body, context.now, requestId);
      const report = await context.index.signal(tenantId, event);
      return { status: 200, body: { ok: true, operation, ...report } };
    }
    case "check": {
      const memoryIds = parseMemoryIds(body, "check");
      const items = await context.index.check(tenantId, memoryIds);
      return { status: 200, body: { ok: true, operation, items } };
    }
    case "validate": {
      const input = parseValidate(body);
      const report = await context.index.validate(tenantId, input.memoryIds, input.results);
      return { status: 200, body: { ok: true, operation, ...report } };
    }
    case "retrieve": {
      const memoryIds = parseMemoryIds(body, "retrieve");
      const checks = await context.index.check(tenantId, memoryIds);
      const items: JsonRecord[] = [];
      for (const check of checks) {
        if (check.decision === "REJECT") continue;
        const memory = await context.store.get(tenantId, check.memoryId);
        if (memory === undefined) continue;
        items.push({
          memoryId: memory.memoryId,
          envelope: memory.envelope,
          status: check.status,
          decision: check.decision,
          ...(memory.content === undefined ? {} : { content: memory.content })
        });
      }
      return { status: 200, body: { ok: true, operation, items } };
    }
  }
}

function parseMemory(body: unknown, operation: "register" | "derive"): StoredMemory {
  const issues: ValidationIssue[] = [];
  if (!isRecord(body)) throw validationError("Request body must be an object", [{ path: "$", message: "must be an object" }]);
  const extracted = extractEnvelope(body, issues);
  issues.push(...validateMemoryEnvelope(extracted.envelope));
  if (isRecord(extracted.envelope) && Array.isArray(extracted.envelope.dependsOn)) {
    if (operation === "register" && extracted.envelope.dependsOn.length > 0) {
      issues.push({ path: "$.dependsOn", message: "register requires an empty dependsOn array" });
    }
    if (operation === "derive" && extracted.envelope.dependsOn.length === 0) {
      issues.push({ path: "$.dependsOn", message: "derive requires at least one dependency" });
    }
  }
  if (issues.length > 0) throw validationError("Invalid memory request", issues);
  const envelope = extracted.envelope as MemoryEnvelope;
  return extracted.hasContent
    ? { memoryId: envelope.memoryId, envelope, content: extracted.content }
    : { memoryId: envelope.memoryId, envelope };
}

function extractEnvelope(body: JsonRecord, issues: ValidationIssue[]): { envelope: unknown; hasContent: boolean; content: unknown } {
  const hasWrappedEnvelope = hasOwn(body, "envelope");
  const allowed = hasWrappedEnvelope
    ? new Set(["envelope", "memoryId", "content"])
    : new Set(["specVersion", "memoryId", "contentDigest", "provenance", "validity", "dependsOn", "content"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) issues.push({ path: `$.${key}`, message: "is not a permitted request field" });
  }
  const envelope = hasWrappedEnvelope
    ? body.envelope
    : Object.fromEntries(Object.entries(body).filter(([key]) => key !== "content"));
  if (hasOwn(body, "memoryId") && isRecord(envelope) && body.memoryId !== envelope.memoryId) {
    issues.push({ path: "$.memoryId", message: "must match envelope.memoryId" });
  }
  return { envelope, hasContent: hasOwn(body, "content"), content: body.content };
}

function parseMemoryIds(body: unknown, operation: "check" | "retrieve"): readonly string[] {
  if (!isRecord(body)) throw validationError("Invalid memory request", [{ path: "$", message: "must be an object" }]);
  const raw = hasOwn(body, "memoryIds") ? body.memoryIds : body.memoryId;
  const memoryIds = typeof raw === "string" ? [raw] : raw;
  const issues: ValidationIssue[] = [];
  if (hasOwn(body, "memoryIds") && hasOwn(body, "memoryId")) issues.push({ path: "$", message: "use memoryIds or memoryId, not both" });
  if (!Array.isArray(memoryIds) || memoryIds.length === 0) {
    issues.push({ path: hasOwn(body, "memoryIds") ? "$.memoryIds" : "$.memoryId", message: "must contain at least one memory id" });
  } else {
    memoryIds.forEach((memoryId, index) => {
      if (typeof memoryId !== "string" || memoryId.length === 0) issues.push({ path: `$.memoryIds[${index}]`, message: "must be a non-empty string" });
    });
    if (new Set(memoryIds).size !== memoryIds.length) issues.push({ path: "$.memoryIds", message: "must not contain duplicates" });
  }
  for (const key of Object.keys(body)) if (key !== "memoryIds" && key !== "memoryId") issues.push({ path: `$.${key}`, message: "is not a permitted request field" });
  if (issues.length > 0) throw validationError(`Invalid ${operation} request`, issues);
  return memoryIds as string[];
}

function parseValidate(body: unknown): { memoryIds: readonly string[]; results?: Readonly<Record<string, ValidationResult>> } {
  if (!isRecord(body)) throw validationError("Invalid validate request", [{ path: "$", message: "must be an object" }]);
  const memoryIds = parseMemoryIds({ memoryIds: body.memoryIds, ...(hasOwn(body, "memoryId") ? { memoryId: body.memoryId } : {}) }, "check");
  const issues: ValidationIssue[] = [];
  let results: Readonly<Record<string, ValidationResult>> | undefined;
  if (hasOwn(body, "results")) {
    if (!isRecord(body.results)) issues.push({ path: "$.results", message: "must be an object keyed by memory id" });
    else {
      const parsed: Record<string, ValidationResult> = {};
      for (const [memoryId, result] of Object.entries(body.results)) {
        if (!isValidationResult(result) || result.memoryId !== memoryId) {
          issues.push({ path: `$.results.${memoryId}`, message: "must be a valid validation result with a matching memoryId" });
        } else parsed[memoryId] = result;
      }
      results = parsed;
    }
  }
  for (const key of Object.keys(body)) if (!["memoryIds", "memoryId", "results"].includes(key)) issues.push({ path: `$.${key}`, message: "is not a permitted request field" });
  if (issues.length > 0) throw validationError("Invalid validate request", issues);
  return results === undefined ? { memoryIds } : { memoryIds, results };
}

function parseSignal(body: unknown, now: () => string, requestId: string): PremiseEvent & { readonly type: "SourceChanged" } {
  if (!isRecord(body)) throw validationError("Invalid signal request", [{ path: "$", message: "must be an object" }]);
  const issues: ValidationIssue[] = [];
  const wrapped = hasOwn(body, "event");
  const shorthandInput = !wrapped && typeof body.sourceUri === "string" && isRecord(body.version);
  if (wrapped) {
    for (const key of Object.keys(body)) if (key !== "event") issues.push({ path: `$.${key}`, message: "is not a permitted request field" });
  } else if (shorthandInput) {
    for (const key of Object.keys(body)) if (key !== "sourceUri" && key !== "version") issues.push({ path: `$.${key}`, message: "is not a permitted request field" });
  }
  const candidate = wrapped ? body.event : body;
  const shorthand = shorthandInput
    ? {
        specVersion: SERVER_SPEC_VERSION,
        eventId: requestId,
        type: "SourceChanged" as const,
        occurredAt: now(),
        payload: { sourceUri: body.sourceUri, version: body.version }
      }
    : candidate;
  issues.push(...validatePremiseEvent(shorthand));
  if (isRecord(shorthand) && shorthand.type !== "SourceChanged") issues.push({ path: "$.type", message: "signal only accepts SourceChanged events" });
  if (issues.length > 0) throw validationError("Invalid signal request", issues);
  return shorthand as PremiseEvent & { readonly type: "SourceChanged" };
}

function routeFor(url: string | undefined): { readonly operation: Operation } | undefined {
  let pathname: string;
  try {
    pathname = new URL(url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return undefined;
  }
  const route = pathname.replace(/^\/api(?=\/)/, "").replace(/^\/v1(?=\/)/, "") || "/";
  const operation = route.slice(1) as Operation;
  return new Set<Operation>(["register", "derive", "signal", "check", "validate", "retrieve", "health"]).has(operation)
    ? { operation }
    : undefined;
}

async function resolveTenant(authorize: TenantAuthorizer, context: AuthorizationContext): Promise<string> {
  let principal: TenantPrincipal | string | true | false | null | undefined;
  try {
    principal = await authorize(context);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "UNAUTHORIZED", "Tenant authorization failed");
  }
  if (principal === false || principal === null || principal === undefined) throw new HttpError(401, "UNAUTHORIZED", "Tenant authorization required");
  const tenantId = principal === true ? tenantFromHeader(context.request) ?? "default" : typeof principal === "string" ? principal : principal.tenantId;
  if (typeof tenantId !== "string" || !/^[\x21-\x7e]{1,128}$/.test(tenantId)) throw new HttpError(403, "FORBIDDEN", "Authorizer returned an invalid tenant");
  return tenantId;
}

function defaultAuthorize(context: AuthorizationContext): string {
  return tenantFromHeader(context.request) ?? "default";
}

function tenantFromHeader(request: IncomingMessage): string | undefined {
  const value = request.headers["x-tenant-id"];
  return typeof value === "string" && /^[\x21-\x7e]{1,128}$/.test(value) ? value : undefined;
}

function getRequestId(request: IncomingMessage, create: () => string): string {
  const value = request.headers["x-request-id"] ?? request.headers["request-id"];
  return typeof value === "string" && /^[\x21-\x7e]{1,128}$/.test(value) ? value : create();
}

function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType === "string" && !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string") {
    if (!/^\d+$/.test(contentLength)) throw new HttpError(400, "INVALID_CONTENT_LENGTH", "Content-Length must be a non-negative integer");
    if (Number(contentLength) > maxBytes) {
      request.resume();
      throw new HttpError(413, "BODY_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`);
    }
  }
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        request.resume();
        fail(new HttpError(413, "BODY_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", fail);
    request.on("end", () => {
      if (settled) return;
      settled = true;
      if (bytes === 0) {
        reject(new HttpError(400, "EMPTY_BODY", "Request body must not be empty"));
        return;
      }
      const input = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        input.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(input));
      } catch {
        reject(new HttpError(400, "INVALID_JSON", "Request body must be valid JSON"));
        return;
      }
      resolve(parsed);
    });
  });
}

function validationError(message: string, issues: readonly ValidationIssue[]): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", message, issues);
}

function sendError(response: ServerResponse, error: unknown, requestId: string): void {
  if (response.writableEnded) return;
  const normalized = normalizeError(error);
  sendJson(response, normalized.status, {
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined ? {} : { details: normalized.details })
    }
  }, requestId);
}

function normalizeError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof EnvelopeValidationError) return validationError(error.message, error.issues);
  if (error instanceof PremiseEventValidationError) return validationError(error.message, error.issues);
  if (error instanceof Error) {
    if (/^Unknown memory:|^Unknown dependency:/.test(error.message)) return new HttpError(404, "NOT_FOUND", error.message);
    if (/already registered|Duplicate eventId|Dependency graph contains a cycle|requires at least one dependency|Use derive\(\)/.test(error.message)) {
      return new HttpError(409, "CONFLICT", error.message);
    }
    if (/Invalid validation result|Invalid PREMiSE/.test(error.message)) return new HttpError(422, "VALIDATION_ERROR", error.message);
  }
  return new HttpError(500, "INTERNAL_ERROR", "Internal server error");
}

function sendJson(response: ServerResponse, status: number, body: JsonRecord, requestId: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  const payload = JSON.stringify({ ...body, requestId });
  response.end(payload);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Value must be JSON serializable");
  return JSON.parse(serialized) as T;
}
