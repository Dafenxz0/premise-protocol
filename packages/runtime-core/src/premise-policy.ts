import { createHash } from "node:crypto";
import {
  normalizePremiseValidationScope,
  premiseValidationScopeKey,
  type PremiseValidationScope
} from "./validation-scope.js";

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
  readonly decision: "SUPPORTED" | "UNSUPPORTED";
}

export type PremiseRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type PremisePolicyState = "FRESH" | "STALE" | "INVALID" | "UNKNOWN";
export type PremisePolicyOperation = "READ" | "WRITE";
export type PremiseSourceMode = "IMMUTABLE" | "EVENT_DRIVEN" | "VERSIONED" | "TTL_ONLY" | "UNKNOWN";
export type PremiseEventState = "CURRENT" | "INVALIDATED" | "UNKNOWN" | "NONE";
export type PremiseCasConflict = "REPAIRABLE" | "REVOCATION" | "INCOMPATIBLE_GATE";
export type PremiseValidationMethod = "NONE" | "CONDITIONAL_READ" | "AUTHORITATIVE_READ";

export interface PremiseValidationPlanInput {
  readonly operation: PremisePolicyOperation;
  readonly risk: PremiseRiskLevel;
  readonly state: PremisePolicyState;
  readonly sourceMode: PremiseSourceMode;
  readonly capabilities: readonly PremisePolicyCapability[];
  readonly hasVersionToken?: boolean;
  readonly ttlFresh?: boolean;
  readonly eventState?: PremiseEventState;
  readonly causalFrontierComplete?: boolean;
  /** Complete fresh receipts returned atomically by a failed CAS. */
  readonly casObservedFreshReceipts?: boolean;
  readonly casConflict?: PremiseCasConflict;
  readonly leaseRequired?: boolean;
}

export interface PremiseValidationPlan {
  readonly decision: "USE" | "REVALIDATE" | "REJECT" | "UNSUPPORTED";
  readonly validation: PremiseValidationMethod;
  readonly guardRequired: boolean;
  readonly reason: string;
}

function sourceValidation(input: PremiseValidationPlanInput): PremiseValidationMethod {
  return input.sourceMode === "VERSIONED"
    && input.hasVersionToken === true
    && input.capabilities.includes("CONDITIONAL_READ")
    ? "CONDITIONAL_READ"
    : "AUTHORITATIVE_READ";
}

/**
 * Pure risk-aware planner. It only chooses validation work; WRITE still needs
 * executePremiseGuard and an atomic conditional commit before any effect.
 */
export function planPremiseValidation(input: PremiseValidationPlanInput): PremiseValidationPlan {
  const write = input.operation === "WRITE";
  const highRisk = input.risk === "HIGH" || input.risk === "CRITICAL";
  const validation = sourceValidation(input);
  if (input.state === "INVALID" && !(write && input.casObservedFreshReceipts === true)) {
    return { decision: "REJECT", validation: "NONE", guardRequired: write, reason: "INVALID_EVIDENCE" };
  }
  if (input.state === "UNKNOWN") {
    return input.risk === "CRITICAL"
      ? { decision: "REJECT", validation: "NONE", guardRequired: write, reason: "UNKNOWN_CRITICAL_EVIDENCE" }
      : { decision: "REVALIDATE", validation, guardRequired: write, reason: "UNKNOWN_EVIDENCE" };
  }
  if (input.state === "STALE") return { decision: "REVALIDATE", validation, guardRequired: write, reason: "STALE_EVIDENCE" };

  if (write) {
    const conditionalCommit = input.capabilities.includes("CAS") || input.capabilities.includes("CONDITIONAL_ACTION");
    if (input.sourceMode === "TTL_ONLY" || input.sourceMode === "UNKNOWN" || input.hasVersionToken !== true) {
      return { decision: "UNSUPPORTED", validation: "AUTHORITATIVE_READ", guardRequired: true, reason: "VERSIONED_WRITE_REQUIRED" };
    }
    if (!conditionalCommit || !input.capabilities.includes("IDEMPOTENCY_KEY")) {
      return { decision: "UNSUPPORTED", validation: "NONE", guardRequired: true, reason: "CONDITIONAL_COMMIT_REQUIRED" };
    }
    if (highRisk && (!input.capabilities.includes("CAUSAL_FRONTIER") || input.causalFrontierComplete !== true)) {
      return { decision: "UNSUPPORTED", validation: "NONE", guardRequired: true, reason: "CAUSAL_FRONTIER_REQUIRED" };
    }
    if (input.leaseRequired === true && !input.capabilities.includes("FENCED_LEASE")) {
      return { decision: "UNSUPPORTED", validation: "NONE", guardRequired: true, reason: "FENCED_LEASE_REQUIRED" };
    }
    if (input.casConflict === "REVOCATION") return { decision: "REJECT", validation: "NONE", guardRequired: true, reason: "REVOCATION_CONFLICT" };
    if (input.casConflict === "INCOMPATIBLE_GATE") return { decision: "UNSUPPORTED", validation: "NONE", guardRequired: true, reason: "INCOMPATIBLE_GATE" };
    if (input.casObservedFreshReceipts === true && !input.capabilities.includes("CAS")) {
      return { decision: "UNSUPPORTED", validation: "NONE", guardRequired: true, reason: "CAS_REQUIRED_FOR_OBSERVED_RECEIPTS" };
    }
    if (input.casObservedFreshReceipts === true) {
      return { decision: "USE", validation: "NONE", guardRequired: true, reason: "CAS_OBSERVED_FRESH_RECEIPTS" };
    }
    return { decision: "USE", validation: "NONE", guardRequired: true, reason: "ATOMIC_GUARD_REQUIRED" };
  }

  if (input.sourceMode === "IMMUTABLE") return { decision: "USE", validation: "NONE", guardRequired: false, reason: "IMMUTABLE_SOURCE" };
  if (input.sourceMode === "EVENT_DRIVEN") {
    if (input.eventState === "INVALIDATED") return { decision: "REVALIDATE", validation, guardRequired: false, reason: "EVENT_INVALIDATED" };
    const orderedCoverage = input.eventState === "CURRENT"
      && input.capabilities.includes("SUBSCRIPTIONS")
      && input.capabilities.includes("ORDERED_EVENTS")
      && (!highRisk || input.causalFrontierComplete === true);
    if (orderedCoverage) return { decision: "USE", validation: "NONE", guardRequired: false, reason: "ORDERED_EVENT_COVERAGE" };
    if (input.risk === "CRITICAL" && input.eventState === "UNKNOWN") return { decision: "REJECT", validation: "NONE", guardRequired: false, reason: "UNKNOWN_EVENT_COVERAGE" };
    return { decision: "REVALIDATE", validation, guardRequired: false, reason: "EVENT_COVERAGE_INCOMPLETE" };
  }
  if (input.sourceMode === "TTL_ONLY") {
    if (highRisk) return { decision: "UNSUPPORTED", validation: "AUTHORITATIVE_READ", guardRequired: false, reason: "TTL_NOT_ALLOWED_FOR_RISK" };
    return input.ttlFresh === true
      ? { decision: "USE", validation: "NONE", guardRequired: false, reason: "TTL_FRESH_INFORMATIONAL_READ" }
      : { decision: "REVALIDATE", validation: "AUTHORITATIVE_READ", guardRequired: false, reason: "TTL_EXPIRED" };
  }
  if (input.sourceMode === "VERSIONED") {
    if (input.hasVersionToken !== true) return { decision: "UNSUPPORTED", validation: "AUTHORITATIVE_READ", guardRequired: false, reason: "VERSION_TOKEN_REQUIRED" };
    return input.risk === "LOW"
      ? { decision: "USE", validation: "NONE", guardRequired: false, reason: "LOW_RISK_FRESH_RECEIPT" }
      : { decision: "REVALIDATE", validation, guardRequired: false, reason: "RISK_RECHECK_REQUIRED" };
  }
  return { decision: "UNSUPPORTED", validation: "AUTHORITATIVE_READ", guardRequired: false, reason: "SOURCE_MODE_UNKNOWN" };
}

export function negotiatePremisePolicyCapabilities(
  requested: readonly PremisePolicyCapability[],
  available: readonly PremisePolicyCapability[]
): PremisePolicyNegotiation {
  const availableSet = new Set(available);
  const supported = requested.filter((capability) => availableSet.has(capability));
  const unsupported = requested.filter((capability) => !availableSet.has(capability));
  return { supported, unsupported, decision: unsupported.length === 0 ? "SUPPORTED" : "UNSUPPORTED" };
}

/** @deprecated Use PremiseValidationScope. Kept as a complete-scope alias. */
export type PremiseReceiptSharingScope = PremiseValidationScope;

/** @deprecated Use premiseValidationScopeKey. */
export const premiseReceiptSharingKey = premiseValidationScopeKey;

/**
 * Key for one complete multi-resource receipt frontier. Resource identity and
 * version stay per member; the shared query/auth/policy/change-set/causal
 * scope is still part of every member, so only an exact frontier can coalesce.
 */
export function premiseReceiptSharingFrontierKey(scopes: readonly PremiseValidationScope[]): string {
  if (scopes.length === 0) throw new TypeError("PREMiSE frontier must contain at least one resource");
  const members = scopes.map((scope) => {
    const normalized = normalizePremiseValidationScope(scope);
    return { scope: normalized, key: premiseValidationScopeKey(normalized) };
  }).sort((left, right) => left.scope.resourceId.localeCompare(right.scope.resourceId) || left.key.localeCompare(right.key));
  if (new Set(members.map(({ scope }) => scope.resourceId)).size !== members.length) {
    throw new TypeError("PREMiSE frontier cannot contain duplicate resources");
  }
  const projection = JSON.stringify({
    domain: "premise-policy-sharing-frontier/1",
    members: members.map(({ key }) => key)
  });
  return `sha256:${createHash("sha256").update(projection, "utf8").digest("hex")}`;
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

  /** @deprecated Use runScoped unless `key` came from premiseReceiptSharingKey. */
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

  /** Derives the full protocol key so callers cannot accidentally coalesce a partial scope. */
  runScoped(scope: PremiseValidationScope, task: () => Promise<T> | T): Promise<T> {
    return this.run(premiseReceiptSharingKey(scope), task);
  }

  runFrontier(scopes: readonly PremiseValidationScope[], task: () => Promise<T> | T): Promise<T> {
    return this.run(premiseReceiptSharingFrontierKey(scopes), task);
  }
}
