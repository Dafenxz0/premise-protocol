import type {
  AdapterActionResult,
  AdapterConditionalActionRequest,
  AdapterObservation,
  AdapterRevalidation,
  AdapterRevalidateRequest,
  AdapterObserveRequest,
  PremiseAdapter,
  PremiseAdapterCapabilities
} from "@premise/adapter-sdk";
import type { VersionReference } from "@premise/protocol-types";

export type HttpVersion = VersionReference;

export type HttpVersionExtractor = (response: Response, body: unknown) => HttpVersion | undefined;

export interface HttpAction {
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface HttpAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly versionExtractor?: HttpVersionExtractor;
  readonly allowConditionalAction?: boolean;
  readonly allowLastModifiedAction?: boolean;
  readonly allowCustomIfMatch?: boolean;
  readonly tenantHeader?: string;
}

export class HttpAdapterError extends Error {
  readonly status: number | undefined;
  readonly code: "HTTP" | "TIMEOUT" | "ABORTED" | "PROTOCOL";

  constructor(message: string, status?: number, code: HttpAdapterError["code"] = "HTTP") {
    super(message);
    this.name = "HttpAdapterError";
    this.status = status;
    this.code = code;
  }
}

const defaultVersionExtractor: HttpVersionExtractor = (response) => {
  const etag = response.headers.get("etag");
  if (etag) return { scheme: "http.etag", token: etag };
  const modified = response.headers.get("last-modified");
  if (modified) return { scheme: "http.last-modified", token: modified };
  return undefined;
};

function validHttpDate(value: string): boolean {
  return /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

function resourceUrl(resource: string): string {
  try {
    const url = new URL(resource);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url.toString();
  } catch {
    throw new TypeError("HTTP adapter resources must be absolute http(s) URLs");
  }
}

function nonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

function parseVersion(version: HttpVersion | undefined): HttpVersion {
  if (version === undefined) throw new HttpAdapterError("HTTP response did not expose a usable version", undefined, "PROTOCOL");
  nonEmpty(version.scheme, "version.scheme");
  nonEmpty(version.token, "version.token");
  if (version.scheme === "http.last-modified" && !validHttpDate(version.token)) throw new HttpAdapterError("HTTP Last-Modified is not a valid IMF-fixdate", undefined, "PROTOCOL");
  return Object.freeze({ scheme: version.scheme, token: version.token });
}

async function responseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 304 || !response.ok) return undefined;
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    try { return await response.json(); } catch { throw new HttpAdapterError("HTTP response contained invalid JSON", response.status); }
  }
  return response.text();
}

function sameVersion(left: HttpVersion, right: HttpVersion): boolean {
  return left.scheme === right.scheme && left.token === right.token;
}

function timeoutSignal(timeoutMs: number, parent: AbortSignal | undefined): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return { signal: controller.signal, cleanup: () => { clearTimeout(timer); parent?.removeEventListener("abort", onAbort); } };
}

export class HttpAdapter<T = unknown, TAction = HttpAction, TResult = unknown> implements PremiseAdapter<T, TAction, TResult> {
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly extractVersion: HttpVersionExtractor;
  private readonly allowConditional: boolean;
  private readonly allowLastModifiedAction: boolean;
  private readonly allowCustomIfMatch: boolean;
  private readonly tenantHeader: string | undefined;

  constructor(options: HttpAdapterOptions = {}) {
    const defaultFetch = globalThis.fetch;
    if (options.fetch === undefined && typeof defaultFetch !== "function") throw new TypeError("HTTP adapter requires fetch or an injected fetch");
    this.fetchImpl = options.fetch ?? defaultFetch.bind(globalThis);
    this.headers = { ...(options.headers ?? {}) };
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new RangeError("timeoutMs must be a positive integer");
    this.now = options.now ?? (() => Date.now());
    this.extractVersion = options.versionExtractor ?? defaultVersionExtractor;
    this.allowConditional = options.allowConditionalAction ?? true;
    this.allowLastModifiedAction = options.allowLastModifiedAction ?? false;
    this.allowCustomIfMatch = options.allowCustomIfMatch ?? false;
    this.tenantHeader = options.tenantHeader === undefined ? undefined : (nonEmpty(options.tenantHeader, "tenantHeader"), options.tenantHeader);
  }

  capabilities(): PremiseAdapterCapabilities {
    const features: PremiseAdapterCapabilities["features"] = this.allowConditional
      ? ["OBSERVE", "REVALIDATE", "CONDITIONAL_ACTION"]
      : ["OBSERVE", "REVALIDATE"];
    return Object.freeze({
      contract: "premise-adapter/2",
      adapterId: "http",
      features: Object.freeze(features)
    });
  }

  async observe(request: AdapterObserveRequest): Promise<AdapterObservation<T>> {
    nonEmpty(request.tenantId, "tenantId");
    const resource = resourceUrl(request.resource);
    const { response, body } = await this.request(resource, "GET", request.tenantId, undefined, request.signal);
    if (!response.ok) throw new HttpAdapterError(`HTTP observe failed (${response.status})`, response.status);
    const typedBody = body as T;
    const version = parseVersion(this.extractVersion(response, typedBody));
    const observedAt = new Date(this.now()).toISOString();
    return Object.freeze({
      tenantId: request.tenantId,
      resource,
      value: typedBody,
      version,
      observedAt,
      evidence: Object.freeze([{ evidenceId: `http:${request.tenantId}:${resource}`, sourceUri: resource, observedAt, version, validator: { id: "http", operation: "GET" } }])
    });
  }

  async revalidate(request: AdapterRevalidateRequest<T>): Promise<AdapterRevalidation> {
    const resource = resourceUrl(request.evidence.sourceUri);
    const previous = request.expectedVersion ?? request.evidence.version;
    const headers: Record<string, string> = {};
    if (previous?.scheme === "http.etag") headers["If-None-Match"] = previous.token;
    if (previous?.scheme === "http.last-modified") headers["If-Modified-Since"] = previous.token;
    try {
      const { response, body } = await this.request(resource, "GET", request.tenantId, headers, request.signal);
      const checkedAt = new Date(this.now()).toISOString();
      if (response.status === 304) return { result: "UNCHANGED", checkedAt, ...(previous === undefined ? {} : { version: previous }) };
      if (response.status === 404) return { result: "MISSING", checkedAt };
      if (response.status === 412) return { result: "PRECONDITION_FAILED", status: 412, checkedAt, reason: "HTTP precondition failed" };
      if (!response.ok) return { result: "UNKNOWN", checkedAt, reason: `HTTP ${response.status}` };
      const current = parseVersion(this.extractVersion(response, body));
      return { result: previous !== undefined && sameVersion(previous, current) ? "UNCHANGED" : "CHANGED", checkedAt, version: current };
    } catch (error) {
      if (error instanceof HttpAdapterError && error.status === 404) return { result: "MISSING", checkedAt: new Date(this.now()).toISOString() };
      return { result: "UNKNOWN", checkedAt: new Date(this.now()).toISOString(), reason: error instanceof HttpAdapterError ? error.code : error instanceof Error ? error.message : String(error) };
    }
  }

  async conditionalAction(request: AdapterConditionalActionRequest<TAction>): Promise<AdapterActionResult<TResult>> {
    if (!this.allowConditional) return { accepted: false, reason: "REJECT" };
    const action = (request.action ?? {}) as HttpAction;
    const method = action.method ?? "POST";
    const scheme = request.expectedVersion.scheme;
    const token = request.expectedVersion.token;
    if (scheme === "http.etag" && token.startsWith("W/")) return { accepted: false, reason: "REJECT", status: 412 };
    if (scheme === "http.last-modified" && !this.allowLastModifiedAction) return { accepted: false, reason: "REJECT", status: 412 };
    if (scheme !== "http.etag" && scheme !== "http.last-modified" && !this.allowCustomIfMatch) return { accepted: false, reason: "REJECT", status: 412 };
    const headers: Record<string, string> = { ...(action.headers ?? {}) };
    if (scheme === "http.last-modified") headers["If-Unmodified-Since"] = token;
    else headers["If-Match"] = token;
    if (action.body !== undefined) headers["Content-Type"] ??= "application/json";
    const body = action.body === undefined ? undefined : typeof action.body === "string" ? action.body : JSON.stringify(action.body);
    const { response, body: responseValue } = await this.request(resourceUrl(request.resource), method, request.tenantId, headers, request.signal, body);
    if (response.status === 412) {
      const observedToken = response.headers.get("etag");
      return { accepted: false, reason: "VERSION_MISMATCH", status: 412, ...(observedToken === null ? {} : { observedVersion: { scheme: "http.etag", token: observedToken } }) };
    }
    if (!response.ok) return { accepted: false, status: response.status, reason: response.status >= 400 && response.status < 500 ? "REJECT" : "UNKNOWN" };
    return { accepted: true, result: responseValue as TResult, status: response.status };
  }

  private async request(resource: string, method: string, tenantId: string, extra: Readonly<Record<string, string>> | undefined, parent: AbortSignal | undefined, body?: BodyInit): Promise<{ response: Response; body: unknown }> {
    nonEmpty(tenantId, "tenantId");
    if (parent?.aborted) throw new HttpAdapterError("HTTP request aborted", undefined, "ABORTED");
    const timed = timeoutSignal(this.timeoutMs, parent);
    try {
      const headers: Record<string, string> = { ...this.headers, ...(extra ?? {}) };
      if (this.tenantHeader !== undefined) headers[this.tenantHeader] = tenantId;
      const init: RequestInit = { method, headers, signal: timed.signal };
      if (body !== undefined) init.body = body;
      const response = await this.fetchImpl(resource, init);
      const value = await responseBody(response);
      return { response, body: value };
    } catch (error) {
      if (parent?.aborted) throw new HttpAdapterError("HTTP request aborted", undefined, "ABORTED");
      if (timed.signal.aborted) throw new HttpAdapterError("HTTP request timed out", undefined, "TIMEOUT");
      if (error instanceof HttpAdapterError) throw error;
      throw new HttpAdapterError(error instanceof Error ? error.message : "HTTP request failed");
    } finally {
      timed.cleanup();
    }
  }
}

export { HttpAdapter as GenericHttpAdapter };
