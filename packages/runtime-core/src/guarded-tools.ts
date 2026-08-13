import type { VersionReference } from "@premise/protocol-types";

export type GuardedToolState = "FRESH" | "STALE" | "INVALID" | "UNKNOWN" | "MISSING";
export type GuardedToolRevalidationOutcome = "FRESH" | "CHANGED" | "MISSING" | "UNKNOWN" | "VERSION_MISMATCH";
export type GuardedToolActionOutcome = "APPLIED" | "VERSION_MISMATCH" | "REJECTED" | "UNKNOWN";
export type GuardedToolBlockedOutcome = "CHANGED" | "MISSING" | "UNKNOWN" | "VERSION_MISMATCH" | "REJECTED";

export interface GuardedToolResource {
  readonly tenantId: string;
  readonly resource: string;
}

export interface GuardedToolCheck extends GuardedToolResource {
  readonly state: GuardedToolState;
  readonly version?: VersionReference;
  readonly reason?: string;
}

export interface GuardedToolRevalidationRequest extends GuardedToolResource {
  readonly expectedVersion: VersionReference;
}

export interface GuardedToolRevalidation extends GuardedToolResource {
  readonly outcome: GuardedToolRevalidationOutcome;
  readonly observedVersion?: VersionReference;
  readonly reason?: string;
}

export interface GuardedToolActionRequest<TAction = unknown> extends GuardedToolResource {
  readonly expectedVersion: VersionReference;
  readonly idempotencyKey: string;
  readonly action: TAction;
  readonly signal: AbortSignal;
}

export interface GuardedToolActionResponse<TResult = unknown> extends GuardedToolResource {
  readonly outcome: GuardedToolActionOutcome;
  readonly observedVersion?: VersionReference;
  readonly result?: TResult;
  readonly reason?: string;
}

export interface GuardedToolCallbacks<TAction = unknown, TResult = unknown> {
  /** Explicit read/check callback. This layer does not discover or wrap tools. */
  readonly check: (input: GuardedToolResource) => GuardedToolCheck | Promise<GuardedToolCheck>;
  /** Explicit source revalidation callback. */
  readonly revalidate: (input: GuardedToolRevalidationRequest) => GuardedToolRevalidation | Promise<GuardedToolRevalidation>;
  /** The only callback allowed to perform the side effect. It must honor signal and use the supplied version atomically. */
  readonly act: (input: GuardedToolActionRequest<TAction>) => GuardedToolActionResponse<TResult> | Promise<GuardedToolActionResponse<TResult>>;
}

export interface GuardedToolOptions<TAction = unknown, TResult = unknown> {
  readonly callbacks: GuardedToolCallbacks<TAction, TResult>;
  /** Maximum time allowed for the side-effect callback. Defaults to 10 seconds. */
  readonly sideEffectTimeoutMs?: number;
}

declare const checkProof: unique symbol;
declare const readyProof: unique symbol;

export interface GuardedToolCheckResult extends GuardedToolCheck {
  readonly [checkProof]: true;
}

export interface GuardedToolReady extends GuardedToolResource {
  readonly ready: true;
  readonly version: VersionReference;
  readonly [readyProof]: true;
}

export type GuardedToolRevalidationResult = GuardedToolReady | {
  readonly ready: false;
  readonly tenantId: string;
  readonly resource: string;
  readonly outcome: GuardedToolBlockedOutcome;
  readonly observedVersion?: VersionReference;
  readonly reason: string;
};

export interface GuardedToolActionResult<TResult = unknown> extends GuardedToolResource {
  readonly accepted: boolean;
  readonly outcome: GuardedToolActionOutcome;
  readonly expectedVersion?: VersionReference;
  readonly observedVersion?: VersionReference;
  readonly result?: TResult;
  readonly reason?: string;
}

interface ProofResource extends GuardedToolResource {
  readonly version: VersionReference;
}

interface StoredAction<TResult> {
  readonly fingerprint: string;
  readonly result: Promise<GuardedToolActionResult<TResult>>;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validVersion(value: unknown): value is VersionReference {
  return typeof value === "object"
    && value !== null
    && nonEmpty((value as VersionReference).scheme)
    && nonEmpty((value as VersionReference).token);
}

function sameResource(left: GuardedToolResource, right: GuardedToolResource): boolean {
  return left.tenantId === right.tenantId && left.resource === right.resource;
}

function sameVersion(left: VersionReference, right: VersionReference): boolean {
  return left.scheme === right.scheme && left.token === right.token;
}

function resourceFrom(value: unknown): GuardedToolResource | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as GuardedToolResource;
  return nonEmpty(candidate.tenantId) && nonEmpty(candidate.resource)
    ? { tenantId: candidate.tenantId, resource: candidate.resource }
    : undefined;
}

function assertResource(value: GuardedToolResource): void {
  if (resourceFrom(value) === undefined) throw new TypeError("tenantId and resource must be non-empty strings");
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("action is not JSON serializable");
    return encoded;
  }
  if (value === undefined) return "undefined";
  if (typeof value !== "object") throw new TypeError("action is not JSON serializable");
  if (seen.has(value)) throw new TypeError("action is not JSON serializable");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function invalidCheck(input: GuardedToolResource, reason: string): GuardedToolCheckResult {
  return { ...input, state: "UNKNOWN", reason } as GuardedToolCheckResult;
}

function blocked(input: GuardedToolResource, outcome: GuardedToolBlockedOutcome, reason: string, observedVersion?: VersionReference): GuardedToolRevalidationResult {
  return {
    ready: false,
    ...input,
    outcome,
    reason,
    ...(observedVersion === undefined ? {} : { observedVersion })
  };
}

/**
 * Explicit guarded-tool contract. A caller must use the returned check result,
 * then a ready revalidation proof, before this class will invoke `act`.
 *
 * The callbacks are deliberately supplied individually. This is not a proxy,
 * decorator or implicit wrapper around an existing tool.
 */
export class GuardedTool<TAction = unknown, TResult = unknown> {
  private readonly callbacks: GuardedToolCallbacks<TAction, TResult>;
  private readonly timeoutMs: number;
  private readonly checks = new WeakMap<object, GuardedToolResource & { readonly state: GuardedToolState; readonly version?: VersionReference }>();
  private readonly ready = new WeakMap<object, ProofResource>();
  private readonly actions = new Map<string, StoredAction<TResult>>();

  constructor(options: GuardedToolOptions<TAction, TResult>) {
    if (options === undefined || options.callbacks === undefined) throw new TypeError("callbacks are required");
    if (typeof options.callbacks.check !== "function" || typeof options.callbacks.revalidate !== "function" || typeof options.callbacks.act !== "function") {
      throw new TypeError("callbacks must implement check, revalidate and act explicitly");
    }
    this.callbacks = options.callbacks;
    this.timeoutMs = options.sideEffectTimeoutMs ?? 10_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new TypeError("sideEffectTimeoutMs must be positive");
  }

  async check(input: GuardedToolResource): Promise<GuardedToolCheckResult> {
    assertResource(input);
    try {
      const result = await this.callbacks.check({ tenantId: input.tenantId, resource: input.resource });
      if (typeof result !== "object" || result === null || !sameResource(result, input)) return invalidCheck(input, "CHECK_RESOURCE_MISMATCH");
      if (!["FRESH", "STALE", "INVALID", "UNKNOWN", "MISSING"].includes(result.state)) return invalidCheck(input, "CHECK_STATE_INVALID");
      if ((result.state === "FRESH" || result.state === "STALE") && !validVersion(result.version)) return invalidCheck(input, "CHECK_VERSION_REQUIRED");
      if (result.version !== undefined && !validVersion(result.version)) return invalidCheck(input, "CHECK_VERSION_INVALID");
      const checked = { ...input, state: result.state, ...(result.version === undefined ? {} : { version: result.version }), ...(result.reason === undefined ? {} : { reason: result.reason }) } as GuardedToolCheckResult;
      this.checks.set(checked, { ...input, state: result.state, ...(result.version === undefined ? {} : { version: result.version }) });
      return checked;
    } catch {
      return invalidCheck(input, "CHECK_UNKNOWN");
    }
  }

  async revalidate(input: GuardedToolCheckResult): Promise<GuardedToolRevalidationResult> {
    const stored = typeof input === "object" && input !== null ? this.checks.get(input) : undefined;
    const resource = resourceFrom(input) ?? { tenantId: "", resource: "" };
    if (stored === undefined || !sameResource(stored, resource)) return blocked(resource, "UNKNOWN", "INVALID_CHECK");
    if (stored.state === "MISSING") return blocked(resource, "MISSING", "MISSING_RESOURCE");
    if (stored.state === "UNKNOWN") return blocked(resource, "UNKNOWN", "UNKNOWN_CHECK");
    if (stored.state === "INVALID") return blocked(resource, "REJECTED", "INVALID_CHECK_STATE");
    if (!validVersion(stored.version)) return blocked(resource, "UNKNOWN", "VERSION_REQUIRED");
    const request: GuardedToolRevalidationRequest = { ...resource, expectedVersion: stored.version };
    try {
      const result = await this.callbacks.revalidate(request);
      if (typeof result !== "object" || result === null || !sameResource(result, resource)) return blocked(resource, "UNKNOWN", "REVALIDATE_RESOURCE_MISMATCH");
      if (!["FRESH", "CHANGED", "MISSING", "UNKNOWN", "VERSION_MISMATCH"].includes(result.outcome)) return blocked(resource, "UNKNOWN", "REVALIDATE_OUTCOME_INVALID");
      if (result.observedVersion !== undefined && !validVersion(result.observedVersion)) return blocked(resource, "UNKNOWN", "REVALIDATE_VERSION_INVALID");
      if (result.outcome !== "FRESH") return blocked(resource, result.outcome === "CHANGED" ? "CHANGED" : result.outcome, result.reason ?? result.outcome, result.observedVersion);
      if (!validVersion(result.observedVersion)) return blocked(resource, "UNKNOWN", "FRESH_VERSION_REQUIRED");
      const proof = { ready: true as const, ...resource, version: result.observedVersion } as GuardedToolReady;
      this.ready.set(proof, { ...resource, version: result.observedVersion });
      return proof;
    } catch {
      return blocked(resource, "UNKNOWN", "REVALIDATE_UNKNOWN");
    }
  }

  act(input: GuardedToolReady, action: TAction, idempotencyKey: string): Promise<GuardedToolActionResult<TResult>> {
    const stored = typeof input === "object" && input !== null ? this.ready.get(input) : undefined;
    const resource = resourceFrom(input) ?? { tenantId: "", resource: "" };
    if (stored === undefined || !sameResource(stored, resource) || !validVersion(input?.version)) {
      return Promise.resolve({ accepted: false, outcome: "REJECTED", ...resource, reason: "INVALID_REVALIDATION" });
    }
    if (!nonEmpty(idempotencyKey)) {
      return Promise.resolve({ accepted: false, outcome: "REJECTED", ...resource, expectedVersion: stored.version, reason: "IDEMPOTENCY_KEY_REQUIRED" });
    }
    let actionDigest: string;
    try {
      actionDigest = canonicalJson(action);
    } catch {
      return Promise.resolve({ accepted: false, outcome: "REJECTED", ...resource, expectedVersion: stored.version, reason: "INVALID_ACTION" });
    }
    const fingerprint = `${resource.resource}\u0000${stored.version.scheme}\u0000${stored.version.token}\u0000${actionDigest}`;
    const key = `${resource.tenantId}\u0000${idempotencyKey}`;
    const existing = this.actions.get(key);
    if (existing !== undefined) {
      return existing.fingerprint === fingerprint
        ? existing.result
        : Promise.resolve({ accepted: false, outcome: "REJECTED", ...resource, expectedVersion: stored.version, reason: "IDEMPOTENCY_CONFLICT" });
    }
    const result = Promise.resolve().then(() => this.performAction(resource, stored.version, action, idempotencyKey));
    this.actions.set(key, { fingerprint, result });
    return result;
  }

  private async performAction(resource: GuardedToolResource, version: VersionReference, action: TAction, idempotencyKey: string): Promise<GuardedToolActionResult<TResult>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("SIDE_EFFECT_TIMEOUT"));
      }, this.timeoutMs);
    });
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => this.callbacks.act({ ...resource, expectedVersion: version, idempotencyKey, action, signal: controller.signal })),
        timeout
      ]);
      if (typeof response !== "object" || response === null || !sameResource(response, resource)) return { accepted: false, outcome: "UNKNOWN", ...resource, expectedVersion: version, reason: "ACT_RESOURCE_MISMATCH" };
      if (!["APPLIED", "VERSION_MISMATCH", "REJECTED", "UNKNOWN"].includes(response.outcome)) return { accepted: false, outcome: "UNKNOWN", ...resource, expectedVersion: version, reason: "ACT_OUTCOME_INVALID" };
      if (response.observedVersion !== undefined && !validVersion(response.observedVersion)) return { accepted: false, outcome: "UNKNOWN", ...resource, expectedVersion: version, reason: "ACT_VERSION_INVALID" };
      return {
        accepted: response.outcome === "APPLIED",
        outcome: response.outcome,
        ...resource,
        expectedVersion: version,
        ...(response.observedVersion === undefined ? {} : { observedVersion: response.observedVersion }),
        ...(response.result === undefined ? {} : { result: response.result }),
        ...(response.reason === undefined ? {} : { reason: response.reason })
      };
    } catch {
      return { accepted: false, outcome: "UNKNOWN", ...resource, expectedVersion: version, reason: timedOut ? "SIDE_EFFECT_TIMEOUT" : "SIDE_EFFECT_UNKNOWN" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export function createGuardedTool<TAction = unknown, TResult = unknown>(options: GuardedToolOptions<TAction, TResult>): GuardedTool<TAction, TResult> {
  return new GuardedTool(options);
}
