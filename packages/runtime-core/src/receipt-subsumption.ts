export const RECEIPT_SUBSUMPTION_SPEC_VERSION = "premise-receipt-subsumption/1" as const;
export type ReceiptSubsumptionReason = "MATCH" | "TENANT_MISMATCH" | "RESOURCE_MISMATCH" | "INCARNATION_MISMATCH" | "VERSION_MISMATCH" | "AUTHORIZATION_MISMATCH" | "POLICY_MISMATCH" | "VALIDATOR_MISMATCH" | "QUERY_FAMILY_MISMATCH" | "QUERY_INSUFFICIENT" | "SCOPE_INSUFFICIENT" | "FRONTIER_INSUFFICIENT" | "EXPIRED" | "INVALID";

export interface ReceiptScope {
  readonly tenantId: string;
  readonly resourceId: string;
  readonly incarnationId: string;
  readonly versionToken: string;
  readonly validatorId: string;
  readonly authorizationContextDigest: string;
  readonly policyDigest: string;
  readonly queryFamily: string;
  readonly queryParts: readonly string[];
  readonly scopes: readonly string[];
  readonly causalFrontier: readonly string[];
}

export interface ReceiptCandidate<T = unknown> {
  readonly receiptId: string;
  readonly scope: ReceiptScope;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly value: T;
}

export interface ReceiptRequirement {
  readonly scope: ReceiptScope;
  readonly requiredQueryParts: readonly string[];
  readonly requiredScopes: readonly string[];
  readonly requiredFrontier: readonly string[];
  readonly now: string;
}

export interface ReceiptSubsumptionResult<T = unknown> {
  readonly eligible: boolean;
  readonly reason: ReceiptSubsumptionReason;
  readonly receipt?: ReceiptCandidate<T>;
}

function required(value: unknown, name: string): string { if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be non-empty`); return value; }
function set(values: readonly string[], name: string): Set<string> { if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.trim().length === 0)) throw new TypeError(`${name} must contain non-empty strings`); return new Set(values); }
function timestamp(value: unknown, name: string): number { const text = required(value, name); const parsed = Date.parse(text); if (Number.isNaN(parsed)) throw new TypeError(`${name} must be an ISO timestamp`); return parsed; }

function covers(available: Set<string>, requiredValues: Set<string>): boolean { for (const value of requiredValues) if (!available.has(value)) return false; return true; }

function scopeReason(candidate: ReceiptScope, requiredScope: ReceiptScope, requirement: ReceiptRequirement): ReceiptSubsumptionReason {
  if (candidate.tenantId !== requiredScope.tenantId) return "TENANT_MISMATCH";
  if (candidate.resourceId !== requiredScope.resourceId) return "RESOURCE_MISMATCH";
  if (candidate.incarnationId !== requiredScope.incarnationId) return "INCARNATION_MISMATCH";
  if (candidate.versionToken !== requiredScope.versionToken) return "VERSION_MISMATCH";
  if (candidate.validatorId !== requiredScope.validatorId) return "VALIDATOR_MISMATCH";
  if (candidate.authorizationContextDigest !== requiredScope.authorizationContextDigest) return "AUTHORIZATION_MISMATCH";
  if (candidate.policyDigest !== requiredScope.policyDigest) return "POLICY_MISMATCH";
  if (candidate.queryFamily !== requiredScope.queryFamily) return "QUERY_FAMILY_MISMATCH";
  if (!covers(set(candidate.queryParts, "candidate.queryParts"), set(requirement.requiredQueryParts, "requiredQueryParts"))) return "QUERY_INSUFFICIENT";
  if (!covers(set(candidate.scopes, "candidate.scopes"), set(requirement.requiredScopes, "requiredScopes"))) return "SCOPE_INSUFFICIENT";
  if (!covers(set(candidate.causalFrontier, "candidate.causalFrontier"), set(requirement.requiredFrontier, "requiredFrontier"))) return "FRONTIER_INSUFFICIENT";
  return "MATCH";
}

export function assessReceiptSubsumption<T>(candidate: ReceiptCandidate<T>, requirement: ReceiptRequirement): ReceiptSubsumptionResult<T> {
  try {
    required(candidate.receiptId, "receiptId");
    const now = timestamp(requirement.now, "now");
    if (now >= timestamp(candidate.expiresAt, "expiresAt")) return { eligible: false, reason: "EXPIRED" };
    timestamp(candidate.observedAt, "observedAt");
    const reason = scopeReason(candidate.scope, requirement.scope, requirement);
    return reason === "MATCH" ? { eligible: true, reason, receipt: candidate } : { eligible: false, reason };
  } catch {
    return { eligible: false, reason: "INVALID" };
  }
}

export function selectSubsumingReceipt<T>(candidates: readonly ReceiptCandidate<T>[], requirement: ReceiptRequirement): ReceiptSubsumptionResult<T> {
  const eligible = candidates
    .map((candidate) => assessReceiptSubsumption(candidate, requirement))
    .filter((result): result is ReceiptSubsumptionResult<T> & { readonly receipt: ReceiptCandidate<T> } => result.eligible && result.receipt !== undefined)
    .sort((left, right) => left.receipt.receiptId.localeCompare(right.receipt.receiptId));
  return eligible[0] ?? { eligible: false, reason: "INVALID" };
}
