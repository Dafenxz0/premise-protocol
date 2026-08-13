export type ValidationLeaseScope = Readonly<{
  readonly tenantId: string;
  readonly resourceId: string;
}>;

export type ValidationLease = Readonly<ValidationLeaseScope & {
  readonly owner: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly acquiredAt: number;
  readonly renewedAt: number;
  readonly expiresAt: number;
}>;

export type ValidationLeaseReason =
  | "OK"
  | "INVALID_INPUT"
  | "CLOCK_UNAVAILABLE"
  | "CLOCK_REGRESSION"
  | "STORE_UNAVAILABLE"
  | "LEASE_ACTIVE"
  | "LEASE_MISSING"
  | "LEASE_EXPIRED"
  | "OWNER_MISMATCH"
  | "LEASE_ID_MISMATCH"
  | "STALE_FENCING_TOKEN";

export type ValidationLeaseDecision = Readonly<{
  readonly accepted: boolean;
  readonly decision: "ACQUIRED" | "ALREADY_HELD" | "CONTENDED" | "RENEWED" | "RELEASED" | "VALID" | "REJECTED";
  readonly reason: ValidationLeaseReason;
  readonly lease?: ValidationLease;
}>;

export type ValidationLeaseAcquireRequest = Readonly<ValidationLeaseScope & {
  readonly owner: string;
  readonly leaseId: string;
  readonly expiresAt: number;
}>;

export type ValidationLeaseRenewRequest = Readonly<ValidationLeaseScope & {
  readonly owner: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly expiresAt: number;
}>;

export type ValidationLeaseReleaseRequest = Readonly<ValidationLeaseScope & {
  readonly owner: string;
  readonly leaseId: string;
  readonly fencingToken: number;
}>;

export type ValidationLeaseValidateRequest = ValidationLeaseReleaseRequest;

export type ValidationLeaseStoreRejectionReason = Exclude<ValidationLeaseReason, "OK" | "STORE_UNAVAILABLE" | "LEASE_ACTIVE">;

export type ValidationLeaseStoreAcquireResult =
  | Readonly<{ readonly kind: "ACQUIRED"; readonly lease: ValidationLease }>
  | Readonly<{ readonly kind: "HELD"; readonly lease: ValidationLease }>
  | Readonly<{ readonly kind: "REJECTED"; readonly reason: ValidationLeaseStoreRejectionReason }>;

export type ValidationLeaseStoreMutationResult =
  | Readonly<{ readonly kind: "UPDATED"; readonly lease: ValidationLease }>
  | Readonly<{ readonly kind: "RELEASED" }>
  | Readonly<{ readonly kind: "REJECTED"; readonly reason: ValidationLeaseStoreRejectionReason }>;

export type ValidationLeaseStoreValidationResult =
  | Readonly<{ readonly kind: "VALID"; readonly lease: ValidationLease }>
  | Readonly<{ readonly kind: "REJECTED"; readonly reason: ValidationLeaseStoreRejectionReason }>;

/**
 * Atomic operations required from a real lease store.
 *
 * The in-memory implementation below is deliberately the only implementation
 * in this package. A durable/distributed adapter must preserve the same
 * compare-and-set and fencing-token semantics before it is used in production.
 */
export interface ValidationLeaseStore {
  acquire(request: ValidationLeaseAcquireRequest, now: number): ValidationLeaseStoreAcquireResult;
  renew(request: ValidationLeaseRenewRequest, now: number): ValidationLeaseStoreMutationResult;
  release(request: ValidationLeaseReleaseRequest, now: number): ValidationLeaseStoreMutationResult;
  validate(request: ValidationLeaseValidateRequest, now: number): ValidationLeaseStoreValidationResult;
}

export interface ValidationLeaseManagerOptions {
  readonly store?: ValidationLeaseStore;
  readonly now?: () => number;
  readonly leaseDurationMs?: number;
}

export type ValidationLeaseAcquireInput = Readonly<ValidationLeaseScope & {
  readonly owner: string;
  readonly leaseId: string;
  readonly durationMs?: number;
}>;

export type ValidationLeaseRenewInput = Readonly<ValidationLeaseScope & {
  readonly owner: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly durationMs?: number;
}>;

export type ValidationLeaseReleaseInput = ValidationLeaseReleaseRequest;
export type ValidationLeaseValidateInput = ValidationLeaseValidateRequest;

const DEFAULT_LEASE_DURATION_MS = 30_000;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object";
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function validScope(value: unknown): value is ValidationLeaseScope {
  return isRecord(value) && validText(value.tenantId) && validText(value.resourceId);
}

function validToken(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validDuration(value: unknown): value is number {
  return validTime(value) && value > 0;
}

function validLeaseForScope(value: unknown, scope: ValidationLeaseScope, now: number): value is ValidationLease {
  if (!isRecord(value)) return false;
  return value.tenantId === scope.tenantId
    && value.resourceId === scope.resourceId
    && validText(value.owner)
    && validText(value.leaseId)
    && validToken(value.fencingToken)
    && validTime(value.acquiredAt)
    && validTime(value.renewedAt)
    && validTime(value.expiresAt)
    && value.acquiredAt <= value.renewedAt
    && value.renewedAt <= now
    && value.expiresAt > now;
}

function freezeLease(value: ValidationLease): ValidationLease {
  return Object.freeze({ ...value });
}

function rejected(reason: ValidationLeaseReason): ValidationLeaseDecision {
  return Object.freeze({ accepted: false, decision: "REJECTED", reason });
}

function successful(
  decision: ValidationLeaseDecision["decision"],
  lease?: ValidationLease
): ValidationLeaseDecision {
  return Object.freeze(lease === undefined
    ? { accepted: true, decision, reason: "OK" }
    : { accepted: true, decision, reason: "OK", lease });
}

function scopeKey(scope: ValidationLeaseScope): string {
  return JSON.stringify([scope.tenantId, scope.resourceId]);
}

function storeReason(value: unknown): ValidationLeaseReason {
  if (value === "INVALID_INPUT" || value === "LEASE_MISSING" || value === "LEASE_EXPIRED"
    || value === "OWNER_MISMATCH" || value === "LEASE_ID_MISMATCH" || value === "STALE_FENCING_TOKEN") {
    return value;
  }
  return "STORE_UNAVAILABLE";
}

/**
 * Small fail-closed coordinator around an atomic lease store.
 *
 * It deliberately does not export itself through runtime-core's public index
 * yet; PR50 is a contract/prototype slice, not a production HA integration.
 */
export class ValidationLeaseManager {
  private readonly store: ValidationLeaseStore;
  private readonly clock: () => number;
  private readonly defaultLeaseDurationMs: number;
  private lastObservedAt: number | undefined;

  constructor(options: ValidationLeaseManagerOptions = {}) {
    this.store = options.store ?? new InMemoryValidationLeaseStore();
    this.clock = options.now ?? (() => Date.now());
    this.defaultLeaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    if (!validDuration(this.defaultLeaseDurationMs)) throw new TypeError("leaseDurationMs must be a positive safe integer");
  }

  acquire(input: ValidationLeaseAcquireInput): ValidationLeaseDecision {
    if (!this.validAcquireInput(input)) return rejected("INVALID_INPUT");
    const at = this.readClock();
    if (!at.accepted) return rejected(at.reason);
    const duration = this.duration(input.durationMs);
    if (duration === undefined) return rejected("INVALID_INPUT");
    const expiresAt = this.expiry(at.value, duration);
    if (expiresAt === undefined) return rejected("INVALID_INPUT");
    try {
      const result = this.store.acquire({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
        owner: input.owner,
        leaseId: input.leaseId,
        expiresAt
      }, at.value);
      if (result.kind === "ACQUIRED") {
        if (!validLeaseForScope(result.lease, input, at.value)) return rejected("STORE_UNAVAILABLE");
        return successful("ACQUIRED", freezeLease(result.lease));
      }
      if (result.kind === "HELD") {
        if (!validLeaseForScope(result.lease, input, at.value)) return rejected("STORE_UNAVAILABLE");
        return result.lease.owner === input.owner && result.lease.leaseId === input.leaseId
          ? Object.freeze({ accepted: false, decision: "ALREADY_HELD", reason: "LEASE_ACTIVE" } as const)
          : Object.freeze({ accepted: false, decision: "CONTENDED", reason: "LEASE_ACTIVE" } as const);
      }
      return rejected(storeReason(result.reason));
    } catch {
      return rejected("STORE_UNAVAILABLE");
    }
  }

  renew(input: ValidationLeaseRenewInput): ValidationLeaseDecision {
    if (!this.validRenewInput(input)) return rejected("INVALID_INPUT");
    const at = this.readClock();
    if (!at.accepted) return rejected(at.reason);
    const duration = this.duration(input.durationMs);
    if (duration === undefined) return rejected("INVALID_INPUT");
    const expiresAt = this.expiry(at.value, duration);
    if (expiresAt === undefined) return rejected("INVALID_INPUT");
    try {
      const result = this.store.renew({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
        owner: input.owner,
        leaseId: input.leaseId,
        fencingToken: input.fencingToken,
        expiresAt
      }, at.value);
      if (result.kind === "UPDATED") {
        if (!validLeaseForScope(result.lease, input, at.value)) return rejected("STORE_UNAVAILABLE");
        return successful("RENEWED", freezeLease(result.lease));
      }
      if (result.kind === "RELEASED") return rejected("STORE_UNAVAILABLE");
      return rejected(storeReason(result.reason));
    } catch {
      return rejected("STORE_UNAVAILABLE");
    }
  }

  release(input: ValidationLeaseReleaseInput): ValidationLeaseDecision {
    if (!this.validMutationInput(input)) return rejected("INVALID_INPUT");
    const at = this.readClock();
    if (!at.accepted) return rejected(at.reason);
    try {
      const result = this.store.release(input, at.value);
      if (result.kind === "RELEASED") return successful("RELEASED");
      if (result.kind === "UPDATED") return rejected("STORE_UNAVAILABLE");
      return rejected(storeReason(result.reason));
    } catch {
      return rejected("STORE_UNAVAILABLE");
    }
  }

  validate(input: ValidationLeaseValidateInput): ValidationLeaseDecision {
    if (!this.validMutationInput(input)) return rejected("INVALID_INPUT");
    const at = this.readClock();
    if (!at.accepted) return rejected(at.reason);
    try {
      const result = this.store.validate(input, at.value);
      if (result.kind === "VALID") {
        if (!validLeaseForScope(result.lease, input, at.value)) return rejected("STORE_UNAVAILABLE");
        return successful("VALID", freezeLease(result.lease));
      }
      return rejected(storeReason(result.reason));
    } catch {
      return rejected("STORE_UNAVAILABLE");
    }
  }

  private validAcquireInput(input: unknown): input is ValidationLeaseAcquireInput {
    const candidate = input as Readonly<Record<string, unknown>>;
    return isRecord(input)
      && validScope(input)
      && validText(candidate.owner)
      && validText(candidate.leaseId)
      && (candidate.durationMs === undefined || validDuration(candidate.durationMs));
  }

  private validRenewInput(input: unknown): input is ValidationLeaseRenewInput {
    const candidate = input as Readonly<Record<string, unknown>>;
    return isRecord(input)
      && validScope(input)
      && validText(candidate.owner)
      && validText(candidate.leaseId)
      && validToken(candidate.fencingToken)
      && (candidate.durationMs === undefined || validDuration(candidate.durationMs));
  }

  private validMutationInput(input: unknown): input is ValidationLeaseReleaseInput {
    const candidate = input as Readonly<Record<string, unknown>>;
    return isRecord(input)
      && validScope(input)
      && validText(candidate.owner)
      && validText(candidate.leaseId)
      && validToken(candidate.fencingToken);
  }

  private duration(value: number | undefined): number | undefined {
    const duration = value ?? this.defaultLeaseDurationMs;
    return validDuration(duration) ? duration : undefined;
  }

  private expiry(now: number, duration: number): number | undefined {
    return now <= Number.MAX_SAFE_INTEGER - duration ? now + duration : undefined;
  }

  private readClock(): Readonly<{ readonly accepted: true; readonly value: number } | { readonly accepted: false; readonly reason: "CLOCK_UNAVAILABLE" | "CLOCK_REGRESSION" }> {
    let value: number;
    try { value = this.clock(); } catch { return { accepted: false, reason: "CLOCK_UNAVAILABLE" }; }
    if (!validTime(value)) return { accepted: false, reason: "CLOCK_UNAVAILABLE" };
    if (this.lastObservedAt !== undefined && value < this.lastObservedAt) return { accepted: false, reason: "CLOCK_REGRESSION" };
    this.lastObservedAt = value;
    return { accepted: true, value };
  }
}

/**
 * Deterministic reference store. Its synchronous map models one atomic store;
 * it is not a cross-process or high-availability implementation.
 */
export class InMemoryValidationLeaseStore implements ValidationLeaseStore {
  private readonly leases = new Map<string, ValidationLease>();
  private readonly fencingCounters = new Map<string, number>();
  private lastObservedAt: number | undefined;

  acquire(request: ValidationLeaseAcquireRequest, now: number): ValidationLeaseStoreAcquireResult {
    this.observeClock(now);
    if (!validAcquireRequest(request, now)) return { kind: "REJECTED", reason: "INVALID_INPUT" };
    const key = scopeKey(request);
    const current = this.active(key, now);
    if (current !== undefined) return { kind: "HELD", lease: current };
    const fencingToken = this.nextToken(key);
    const lease = freezeLease({
      tenantId: request.tenantId,
      resourceId: request.resourceId,
      owner: request.owner,
      leaseId: request.leaseId,
      fencingToken,
      acquiredAt: now,
      renewedAt: now,
      expiresAt: request.expiresAt
    });
    this.leases.set(key, lease);
    return { kind: "ACQUIRED", lease };
  }

  renew(request: ValidationLeaseRenewRequest, now: number): ValidationLeaseStoreMutationResult {
    this.observeClock(now);
    if (!validRenewRequest(request, now)) return { kind: "REJECTED", reason: "INVALID_INPUT" };
    const key = scopeKey(request);
    const current = this.leases.get(key);
    if (current === undefined) return { kind: "REJECTED", reason: "LEASE_MISSING" };
    if (current.expiresAt <= now) {
      this.leases.delete(key);
      return { kind: "REJECTED", reason: "LEASE_EXPIRED" };
    }
    const identityFailure = identityReason(current, request);
    if (identityFailure !== undefined) return { kind: "REJECTED", reason: identityFailure };
    const lease = freezeLease({ ...current, renewedAt: now, expiresAt: request.expiresAt });
    this.leases.set(key, lease);
    return { kind: "UPDATED", lease };
  }

  release(request: ValidationLeaseReleaseRequest, now: number): ValidationLeaseStoreMutationResult {
    this.observeClock(now);
    if (!validReleaseRequest(request)) return { kind: "REJECTED", reason: "INVALID_INPUT" };
    const key = scopeKey(request);
    const current = this.leases.get(key);
    if (current === undefined) return { kind: "REJECTED", reason: "LEASE_MISSING" };
    if (current.expiresAt <= now) {
      this.leases.delete(key);
      return { kind: "REJECTED", reason: "LEASE_EXPIRED" };
    }
    const identityFailure = identityReason(current, request);
    if (identityFailure !== undefined) return { kind: "REJECTED", reason: identityFailure };
    this.leases.delete(key);
    return { kind: "RELEASED" };
  }

  validate(request: ValidationLeaseValidateRequest, now: number): ValidationLeaseStoreValidationResult {
    this.observeClock(now);
    if (!validReleaseRequest(request)) return { kind: "REJECTED", reason: "INVALID_INPUT" };
    const key = scopeKey(request);
    const current = this.leases.get(key);
    if (current === undefined) return { kind: "REJECTED", reason: "LEASE_MISSING" };
    if (current.expiresAt <= now) {
      this.leases.delete(key);
      return { kind: "REJECTED", reason: "LEASE_EXPIRED" };
    }
    const identityFailure = identityReason(current, request);
    if (identityFailure !== undefined) return { kind: "REJECTED", reason: identityFailure };
    return { kind: "VALID", lease: current };
  }

  private observeClock(now: number): void {
    if (!validTime(now)) throw new Error("invalid lease clock");
    if (this.lastObservedAt !== undefined && now < this.lastObservedAt) throw new Error("lease clock regression");
    this.lastObservedAt = now;
  }

  private active(key: string, now: number): ValidationLease | undefined {
    const current = this.leases.get(key);
    if (current === undefined) return undefined;
    if (current.expiresAt <= now) {
      this.leases.delete(key);
      return undefined;
    }
    return current;
  }

  private nextToken(key: string): number {
    const previous = this.fencingCounters.get(key) ?? 0;
    if (previous >= Number.MAX_SAFE_INTEGER) throw new Error("fencing token exhausted");
    const next = previous + 1;
    this.fencingCounters.set(key, next);
    return next;
  }
}

function validAcquireRequest(request: unknown, now: number): request is ValidationLeaseAcquireRequest {
  const candidate = request as Readonly<Record<string, unknown>>;
  return isRecord(request)
    && validScope(request)
    && validText(candidate.owner)
    && validText(candidate.leaseId)
    && validTime(candidate.expiresAt)
    && candidate.expiresAt > now;
}

function validRenewRequest(request: unknown, now: number): request is ValidationLeaseRenewRequest {
  const candidate = request as Readonly<Record<string, unknown>>;
  return isRecord(request)
    && validScope(request)
    && validText(candidate.owner)
    && validText(candidate.leaseId)
    && validToken(candidate.fencingToken)
    && validTime(candidate.expiresAt)
    && candidate.expiresAt > now;
}

function validReleaseRequest(request: unknown): request is ValidationLeaseReleaseRequest {
  const candidate = request as Readonly<Record<string, unknown>>;
  return isRecord(request)
    && validScope(request)
    && validText(candidate.owner)
    && validText(candidate.leaseId)
    && validToken(candidate.fencingToken);
}

function identityReason(
  current: ValidationLease,
  request: Readonly<{ readonly owner: string; readonly leaseId: string; readonly fencingToken: number }>
): ValidationLeaseStoreRejectionReason | undefined {
  if (current.fencingToken !== request.fencingToken) return "STALE_FENCING_TOKEN";
  if (current.owner !== request.owner) return "OWNER_MISMATCH";
  if (current.leaseId !== request.leaseId) return "LEASE_ID_MISMATCH";
  return undefined;
}
