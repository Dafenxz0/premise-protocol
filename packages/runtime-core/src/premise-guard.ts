import type { PremisePolicyCapability } from "./premise-policy.js";

export type PremiseGuardState = "FRESH" | "STALE" | "INVALID" | "UNKNOWN";
export type PremiseGuardDecision = "ALLOW" | "REVALIDATE" | "REJECT" | "UNSUPPORTED";

export interface PremiseGuardReceipt {
  readonly premiseId: string;
  readonly state: PremiseGuardState;
  readonly valid: boolean;
  readonly identityKey: string;
  readonly versionToken: string;
  readonly artifactDigest?: unknown;
  readonly migration?: unknown;
  readonly lease?: unknown;
  readonly alerts?: unknown;
  readonly revoked?: boolean;
}

export interface PremiseGuardIntent {
  readonly actionDigest: string;
  readonly criticalPremises: readonly string[];
  readonly requiredCapability: Extract<PremisePolicyCapability, "CAS" | "CONDITIONAL_ACTION" | "ATOMIC_BATCH">;
  readonly idempotencyKey: string;
  readonly lease?: { readonly leaseId: string; readonly fencingToken: string };
}

export interface PremiseGuardCommitResult<T> {
  readonly accepted: boolean;
  readonly result?: T;
  readonly reason?: "VERSION_MISMATCH" | "REJECT" | "REVALIDATE";
  readonly observedVersion?: string;
  /**
   * Optional current receipts observed atomically by the failed conditional
   * commit. They are new evidence for revalidation, never permission to reuse
   * the receipt that failed.
   */
  readonly observedReceipts?: readonly PremiseGuardReceipt[];
}

export interface PremiseGuardAdapter<T> {
  readonly capabilities: readonly PremisePolicyCapability[];
  commit(intent: PremiseGuardIntent, receipts: readonly PremiseGuardReceipt[]): Promise<PremiseGuardCommitResult<T>> | PremiseGuardCommitResult<T>;
}

export interface PremiseGuardResult<T> {
  readonly accepted: boolean;
  readonly decision: PremiseGuardDecision;
  readonly result?: T;
  readonly reason?: string;
  readonly observedVersion?: string;
  readonly observedReceipts?: readonly PremiseGuardReceipt[];
}

function unique(values: readonly string[]): readonly string[] { return [...new Set(values)]; }

function receiptLeaseUsable(receipt: PremiseGuardReceipt, intent: PremiseGuardIntent): boolean {
  if (intent.lease === undefined) return true;
  const lease = receipt.lease;
  if (typeof lease !== "object" || lease === null) return false;
  const value = lease as { leaseId?: unknown; fencingToken?: unknown; expiresAt?: unknown; invalidated?: unknown };
  return value.leaseId === intent.lease.leaseId
    && value.fencingToken === intent.lease.fencingToken
    && value.invalidated !== true
    && typeof value.expiresAt === "string"
    && Number.isFinite(Date.parse(value.expiresAt))
    && Date.now() < Date.parse(value.expiresAt);
}

const guardStates = new Set<PremiseGuardState>(["FRESH", "STALE", "INVALID", "UNKNOWN"]);

function completeObservedReceipts(
  premiseIds: readonly string[],
  receipts: readonly PremiseGuardReceipt[] | undefined,
  previous: readonly PremiseGuardReceipt[]
): readonly PremiseGuardReceipt[] | undefined {
  if (receipts === undefined || receipts.length !== premiseIds.length) return undefined;
  const byPremise = new Map<string, PremiseGuardReceipt>();
  const previousByPremise = new Map(previous.map((receipt) => [receipt.premiseId, receipt]));
  for (const receipt of receipts) {
    if (
      receipt.premiseId.length === 0
      || receipt.identityKey.length === 0
      || receipt.versionToken.length === 0
      || receipt.valid !== true
      || !guardStates.has(receipt.state)
      || receipt.state !== "FRESH"
      || receipt.revoked === true
      || (typeof receipt.alerts === "string" && receipt.alerts === "RED")
      || (typeof receipt.migration === "string" && receipt.migration === "BLOCKED")
      || byPremise.has(receipt.premiseId)
    ) return undefined;
    const prior = previousByPremise.get(receipt.premiseId);
    if (prior === undefined || ["artifactDigest", "migration", "lease", "alerts"].some((key) => (
      JSON.stringify(receipt[key as keyof PremiseGuardReceipt]) !== JSON.stringify(prior[key as keyof PremiseGuardReceipt])
    ))) return undefined;
    byPremise.set(receipt.premiseId, receipt);
  }
  const ordered = premiseIds.map((premiseId) => byPremise.get(premiseId));
  return ordered.every((receipt) => receipt !== undefined) ? ordered as readonly PremiseGuardReceipt[] : undefined;
}

export async function executePremiseGuard<T>(
  intent: PremiseGuardIntent,
  receipts: readonly PremiseGuardReceipt[],
  adapter: PremiseGuardAdapter<T>
): Promise<PremiseGuardResult<T>> {
  // This is a local execution kernel, not a parser for the premise-guard/1
  // wire contract. Callers must validate tenant, digests, slice closure,
  // expiry and authority before constructing these reduced runtime values.
  if (intent.actionDigest.length === 0 || intent.idempotencyKey.length === 0 || intent.criticalPremises.length === 0) {
    return { accepted: false, decision: "REJECT", reason: "INVALID_INTENT" };
  }
  if (intent.lease !== undefined && (intent.lease.leaseId.length === 0 || intent.lease.fencingToken.length === 0)) {
    return { accepted: false, decision: "REJECT", reason: "INVALID_INTENT" };
  }
  if (unique(intent.criticalPremises).length !== intent.criticalPremises.length) {
    return { accepted: false, decision: "REJECT", reason: "DUPLICATE_PREMISE" };
  }
  if (unique(receipts.map((receipt) => receipt.premiseId)).length !== receipts.length) {
    return { accepted: false, decision: "REJECT", reason: "DUPLICATE_RECEIPT" };
  }
  if (receipts.some((receipt) => (
    receipt.premiseId.length === 0
    || receipt.identityKey.length === 0
    || receipt.versionToken.length === 0
    || typeof receipt.valid !== "boolean"
    || !guardStates.has(receipt.state)
  ))) return { accepted: false, decision: "REJECT", reason: "INVALID_RECEIPT" };
  const hasConditionalCommit = adapter.capabilities.includes("CAS") || adapter.capabilities.includes("CONDITIONAL_ACTION");
  if (
    !adapter.capabilities.includes(intent.requiredCapability)
    || !adapter.capabilities.includes("IDEMPOTENCY_KEY")
    || !hasConditionalCommit
    || (intent.lease !== undefined && !adapter.capabilities.includes("FENCED_LEASE"))
  ) {
    return { accepted: false, decision: "UNSUPPORTED", reason: "MISSING_CONDITIONAL_COMMIT" };
  }
  const byPremise = new Map(receipts.map((receipt) => [receipt.premiseId, receipt]));
  const selected: PremiseGuardReceipt[] = [];
  for (const premiseId of intent.criticalPremises) {
    const receipt = byPremise.get(premiseId);
    if (receipt === undefined) return { accepted: false, decision: "REJECT", reason: "INCOMPLETE_SLICE" };
    if (!receipt.valid || receipt.state === "UNKNOWN" || receipt.state === "INVALID") return { accepted: false, decision: "REJECT", reason: "INVALID_RECEIPT" };
    if (receipt.state === "STALE") return { accepted: false, decision: "REVALIDATE", reason: "STALE_RECEIPT" };
    if (!receiptLeaseUsable(receipt, intent)) return { accepted: false, decision: "REJECT", reason: "INVALID_LEASE" };
    selected.push(receipt);
  }
  const committed = await adapter.commit(intent, selected);
  if (committed.accepted) return { accepted: true, decision: "ALLOW", ...(committed.result === undefined ? {} : { result: committed.result }) };
  if (committed.reason === "VERSION_MISMATCH" || committed.reason === "REVALIDATE") {
    const observedReceipts = completeObservedReceipts(intent.criticalPremises, committed.observedReceipts, selected);
    return {
      accepted: false,
      decision: "REVALIDATE",
      reason: committed.reason,
      ...(committed.observedVersion === undefined ? {} : { observedVersion: committed.observedVersion }),
      ...(observedReceipts === undefined ? {} : { observedReceipts })
    };
  }
  return { accepted: false, decision: "REJECT", reason: committed.reason ?? "COMMIT_REJECTED", ...(committed.observedVersion === undefined ? {} : { observedVersion: committed.observedVersion }) };
}
