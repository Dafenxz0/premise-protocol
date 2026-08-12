export type PremisePolicyCapability =
  | "RESOURCE_IDENTITY"
  | "INCARNATION_ID"
  | "VERSION_TOKEN"
  | "EVIDENCE_PROPERTIES"
  | "SCOPED_READ"
  | "CONDITIONAL_READ"
  | "CHANGE_SET"
  | "BATCH_READ"
  | "SUBSCRIPTIONS"
  | "ORDERED_EVENTS"
  | "TRANSACTION_SNAPSHOT"
  | "CAUSAL_FRONTIER"
  | "CAS"
  | "CONDITIONAL_ACTION"
  | "ATOMIC_BATCH"
  | "IDEMPOTENCY_KEY"
  | "SINGLE_FLIGHT"
  | "SCOPED_SHARING"
  | "FENCED_LEASE"
  | "TTL_ONLY"
  | "UNVERSIONED"
  | "FULL_RESOURCE_ONLY";

export interface PremisePolicyNegotiation {
  readonly supported: readonly PremisePolicyCapability[];
  readonly unsupported: readonly PremisePolicyCapability[];
  readonly decision: "ALLOW" | "UNSUPPORTED";
}

export function negotiatePremisePolicyCapabilities(
  requested: readonly PremisePolicyCapability[],
  available: readonly PremisePolicyCapability[]
): PremisePolicyNegotiation {
  const availableSet = new Set(available);
  const supported = requested.filter((capability) => availableSet.has(capability));
  const unsupported = requested.filter((capability) => !availableSet.has(capability));
  return { supported, unsupported, decision: unsupported.length === 0 ? "ALLOW" : "UNSUPPORTED" };
}

export interface PremiseReceiptSharingScope {
  readonly tenantId: string;
  readonly resourceId: string;
  readonly incarnationId: string;
  readonly scopes: readonly string[];
  readonly validatorId: string;
  readonly authorizationContextDigest: string;
  readonly policyDigest: string;
  readonly causalFrontier: readonly string[];
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  throw new TypeError("PREMiSE policy values must be JSON serializable");
}

export function premiseReceiptSharingKey(scope: PremiseReceiptSharingScope): string {
  return canonical({
    tenantId: scope.tenantId,
    resourceId: scope.resourceId,
    incarnationId: scope.incarnationId,
    scopes: [...scope.scopes].sort(),
    validatorId: scope.validatorId,
    authorizationContextDigest: scope.authorizationContextDigest,
    policyDigest: scope.policyDigest,
    causalFrontier: [...scope.causalFrontier].sort()
  });
}

export interface PremiseLease {
  readonly leaseId: string;
  readonly fencingToken: string;
  readonly expiresAt: string;
  readonly invalidated?: boolean;
}

export function premiseLeaseUsable(lease: PremiseLease, now: string, expectedFencingToken?: string): boolean {
  return lease.invalidated !== true
    && (expectedFencingToken === undefined || lease.fencingToken === expectedFencingToken)
    && Date.parse(now) < Date.parse(lease.expiresAt);
}

/** Coalesces identical in-flight validations while preserving the full scope key. */
export class PremiseSingleFlight<T> {
  private readonly pending = new Map<string, Promise<T>>();

  run(key: string, task: () => Promise<T> | T): Promise<T> {
    const current = this.pending.get(key);
    if (current !== undefined) return current;
    const result = Promise.resolve().then(task);
    this.pending.set(key, result);
    const cleanup = () => {
      if (this.pending.get(key) === result) this.pending.delete(key);
    };
    void result.then(cleanup, cleanup);
    return result;
  }
}
