import type { VersionReference } from "@premise/protocol-types";
import {
  normalizePremiseValidationScope,
  premiseValidationScopeKey,
  premiseValidationSupersessionKey,
  type PremiseValidationScope
} from "./validation-scope.js";

export type FencedValidationResult = "UNCHANGED" | "CHANGED" | "MISSING" | "UNKNOWN";
export type FencedValidationUnknownReason = "TIMEOUT" | "ABORTED" | "FENCED" | "SOURCE_UNKNOWN";

/** Structural abort surface keeps runtime-core free of a DOM type dependency. */
export interface FencedAbortSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

interface FencedAbortController {
  readonly signal: FencedAbortSignal;
  abort(): void;
}

declare const AbortController: { new (): FencedAbortController };

export interface FencedValidationRequest {
  /** Complete scope opts into sharing. */
  readonly scope?: PremiseValidationScope;
  /** Legacy fields remain accepted, but are isolated when scope is absent. */
  readonly tenantId?: string;
  readonly resource?: string;
  readonly expectedVersion?: VersionReference;
  readonly signal?: FencedAbortSignal;
  readonly timeoutMs?: number;
}

export interface FencedValidationInvocation {
  readonly tenantId: string;
  readonly resource: string;
  readonly expectedVersion: VersionReference;
  readonly scope?: PremiseValidationScope;
  readonly fencingToken: number;
  readonly signal: FencedAbortSignal;
}

export interface FencedValidationOutcome<T = unknown> {
  readonly result: FencedValidationResult;
  readonly fencingToken: number;
  readonly value?: T;
  readonly version?: VersionReference;
  readonly reason?: FencedValidationUnknownReason;
}

/** The only source dependency: it performs one validation and never retries it. */
export interface FencedValidationSource<T = unknown> {
  validate(input: FencedValidationInvocation): Promise<FencedValidationOutcome<T>> | FencedValidationOutcome<T>;
}

/** Injectable timers make timeout behavior deterministic without a service. */
export interface FencedSingleFlightTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FencedSingleFlightOptions {
  readonly timeoutMs?: number;
  readonly timers?: FencedSingleFlightTimers;
}

interface Flight<T> {
  readonly key: string;
  readonly resourceKey: string;
  readonly supersessionKey: string;
  readonly fencingToken: number;
  readonly controller: FencedAbortController;
  readonly promise: Promise<FencedValidationOutcome<T>>;
  timeoutTriggered: boolean;
  abortTriggered: boolean;
  timer?: unknown;
}

interface CurrentResourceVersion {
  readonly supersessionKey: string;
  readonly fencingToken: number;
}

const hostTimers = globalThis as unknown as { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void };
const defaultTimers: FencedSingleFlightTimers = {
  setTimeout: (callback, delayMs) => hostTimers.setTimeout(callback, delayMs),
  clearTimeout: (handle) => hostTimers.clearTimeout(handle)
};

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

type NormalizedRequest = {
  readonly tenantId: string;
  readonly resource: string;
  readonly expectedVersion: VersionReference;
  readonly scope?: PremiseValidationScope;
  readonly signal?: FencedAbortSignal;
  readonly timeoutMs?: number;
};

function normalizeRequest(request: FencedValidationRequest): NormalizedRequest {
  if (request === undefined || request === null) throw new TypeError("validation request is required");
  if (request.scope !== undefined) {
    const scope = normalizePremiseValidationScope(request.scope);
    const tenantId = request.tenantId === undefined ? scope.tenantId : required(request.tenantId, "tenantId");
    const resource = request.resource === undefined ? scope.resourceId : required(request.resource, "resource");
    const scheme = request.expectedVersion === undefined ? scope.versionScheme : required(request.expectedVersion.scheme, "expectedVersion.scheme");
    const token = request.expectedVersion === undefined ? scope.versionToken : required(request.expectedVersion.token, "expectedVersion.token");
    if (tenantId !== scope.tenantId || resource !== scope.resourceId || scheme !== scope.versionScheme || token !== scope.versionToken) {
      throw new TypeError("validation request fields do not match its complete scope");
    }
    if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 0)) {
      throw new RangeError("timeoutMs must be a finite non-negative number");
    }
    return {
      tenantId,
      resource,
      expectedVersion: { scheme, token },
      scope,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs })
    };
  }
  const tenantId = required(request.tenantId, "tenantId");
  const resource = required(request.resource, "resource");
  const scheme = required(request.expectedVersion?.scheme, "expectedVersion.scheme");
  const token = required(request.expectedVersion?.token, "expectedVersion.token");
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 0)) {
    throw new RangeError("timeoutMs must be a finite non-negative number");
  }
  return {
    tenantId,
    resource,
    expectedVersion: { scheme, token },
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs })
  };
}

function resourceKey(tenantId: string, resource: string): string {
  return JSON.stringify([tenantId, resource]);
}

function unknown<T>(fencingToken: number, reason: FencedValidationUnknownReason): FencedValidationOutcome<T> {
  return { result: "UNKNOWN", fencingToken, reason };
}

function isAbortLike(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { readonly name?: unknown; readonly code?: unknown };
  return value.name === "AbortError"
    || value.name === "TimeoutError"
    || value.code === "ABORT_ERR"
    || value.code === "ABORTED"
    || value.code === "ETIMEDOUT"
    || value.code === "TIMEOUT";
}

/**
 * Coalesces one exact validation while fencing older resource versions. The
 * complete validation scope controls sharing; query/auth/policy differences
 * alone do not supersede one another. It owns no I/O, storage, retries or side
 * effects.
 */
export class FencedSingleFlightCoordinator<T = unknown> {
  private readonly flights = new Map<string, Flight<T>>();
  private readonly latestByResource = new Map<string, CurrentResourceVersion>();
  private readonly timers: FencedSingleFlightTimers;
  private readonly defaultTimeoutMs: number | undefined;
  private nextFencingToken = 0;
  private legacyFlight = 0;

  constructor(private readonly source: FencedValidationSource<T>, options: FencedSingleFlightOptions = {}) {
    if (source === undefined || typeof source.validate !== "function") throw new TypeError("source.validate is required");
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      throw new RangeError("timeoutMs must be a finite non-negative number");
    }
    this.defaultTimeoutMs = options.timeoutMs;
    this.timers = options.timers ?? defaultTimers;
  }

  validate(input: FencedValidationRequest): Promise<FencedValidationOutcome<T>> {
    const request = normalizeRequest(input);
    const key = request.scope === undefined
      ? `legacy-isolated:${++this.legacyFlight}`
      : premiseValidationScopeKey(request.scope);
    const existing = this.flights.get(key);
    if (existing !== undefined) return existing.promise;

    const resource = resourceKey(request.tenantId, request.resource);
    // Legacy requests have no incarnation, so preserve their historical
    // fail-closed behavior: every isolated request supersedes the previous one.
    // Complete scopes use only resource version identity for supersession.
    const supersession = request.scope === undefined
      ? key
      : premiseValidationSupersessionKey(request.scope);
    const current = this.latestByResource.get(resource);
    const fencingToken = current?.supersessionKey === supersession
      ? current.fencingToken
      : ++this.nextFencingToken;
    const controller = new AbortController();
    let resolvePublic!: (outcome: FencedValidationOutcome<T>) => void;
    let rejectPublic!: (error: unknown) => void;
    let settled = false;
    const publicPromise = new Promise<FencedValidationOutcome<T>>((resolve, reject) => {
      resolvePublic = resolve;
      rejectPublic = reject;
    });
    const flight: Flight<T> = {
      key,
      resourceKey: resource,
      supersessionKey: supersession,
      fencingToken,
      controller,
      promise: publicPromise,
      timeoutTriggered: false,
      abortTriggered: false
    };
    this.flights.set(key, flight);
    this.latestByResource.set(resource, { supersessionKey: supersession, fencingToken });

    const settle = (outcome: FencedValidationOutcome<T>): void => {
      if (settled) return;
      settled = true;
      resolvePublic(outcome);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      rejectPublic(error);
    };
    const abortAsUnknown = (reason: "ABORTED" | "TIMEOUT"): void => {
      if (settled) return;
      if (reason === "TIMEOUT") flight.timeoutTriggered = true;
      else flight.abortTriggered = true;
      controller.abort();
      settle(unknown(fencingToken, reason));
    };

    const onAbort = (): void => abortAsUnknown("ABORTED");
    if (request.signal !== undefined) {
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
    }

    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    if (timeoutMs !== undefined) flight.timer = this.timers.setTimeout(() => abortAsUnknown("TIMEOUT"), timeoutMs);

    const operation = Promise.resolve().then(() => {
      if (controller.signal.aborted) return unknown<T>(fencingToken, flight.abortTriggered ? "ABORTED" : "TIMEOUT");
      return this.source.validate({
        tenantId: request.tenantId,
        resource: request.resource,
        expectedVersion: request.expectedVersion,
        ...(request.scope === undefined ? {} : { scope: request.scope }),
        fencingToken,
        signal: controller.signal
      });
    });

    void operation.then((outcome) => {
      if (settled) return;
      const latest = this.latestByResource.get(resource);
      if (latest?.supersessionKey !== supersession
        || latest.fencingToken !== fencingToken
        || outcome.fencingToken !== fencingToken) {
        settle(unknown(fencingToken, "FENCED"));
        return;
      }
      settle(outcome);
    }, (error: unknown) => {
      if (settled) return;
      if (flight.timeoutTriggered) {
        settle(unknown(fencingToken, "TIMEOUT"));
        return;
      }
      if (flight.abortTriggered || isAbortLike(error)) {
        settle(unknown(fencingToken, "ABORTED"));
        return;
      }
      fail(error);
    }).finally(() => {
      if (flight.timer !== undefined) this.timers.clearTimeout(flight.timer);
      request.signal?.removeEventListener("abort", onAbort);
      if (this.flights.get(key) === flight) this.flights.delete(key);
      const anotherFlightForResource = [...this.flights.values()].some((other) => other.resourceKey === resource);
      if (!anotherFlightForResource) {
        this.latestByResource.delete(resource);
      }
    });

    return publicPromise;
  }
}
