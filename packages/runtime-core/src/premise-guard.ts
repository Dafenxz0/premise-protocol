import type { PremisePolicyCapability } from "./premise-policy.js";

export type PremiseGuardState = "FRESH" | "STALE" | "INVALID" | "UNKNOWN";
export type PremiseGuardDecision = "ALLOW" | "REVALIDATE" | "REJECT" | "UNSUPPORTED";

export interface PremiseGuardReceipt {
  readonly premiseId: string;
  readonly state: PremiseGuardState;
  readonly valid: boolean;
  readonly identityKey: string;
  readonly versionToken: string;
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
}

function unique(values: readonly string[]): readonly string[] { return [...new Set(values)]; }

export async function executePremiseGuard<T>(
  intent: PremiseGuardIntent,
  receipts: readonly PremiseGuardReceipt[],
  adapter: PremiseGuardAdapter<T>
): Promise<PremiseGuardResult<T>> {
  if (intent.actionDigest.length === 0 || intent.idempotencyKey.length === 0 || intent.criticalPremises.length === 0) {
    return { accepted: false, decision: "REJECT", reason: "INVALID_INTENT" };
  }
  if (unique(intent.criticalPremises).length !== intent.criticalPremises.length) {
    return { accepted: false, decision: "REJECT", reason: "DUPLICATE_PREMISE" };
  }
  if (!adapter.capabilities.includes(intent.requiredCapability) || !adapter.capabilities.includes("IDEMPOTENCY_KEY")) {
    return { accepted: false, decision: "UNSUPPORTED", reason: "MISSING_CONDITIONAL_COMMIT" };
  }
  const byPremise = new Map(receipts.map((receipt) => [receipt.premiseId, receipt]));
  const selected: PremiseGuardReceipt[] = [];
  for (const premiseId of intent.criticalPremises) {
    const receipt = byPremise.get(premiseId);
    if (receipt === undefined) return { accepted: false, decision: "REJECT", reason: "INCOMPLETE_SLICE" };
    if (!receipt.valid || receipt.state === "UNKNOWN" || receipt.state === "INVALID") return { accepted: false, decision: "REJECT", reason: "INVALID_RECEIPT" };
    if (receipt.state === "STALE") return { accepted: false, decision: "REVALIDATE", reason: "STALE_RECEIPT" };
    selected.push(receipt);
  }
  const committed = await adapter.commit(intent, selected);
  if (committed.accepted) return { accepted: true, decision: "ALLOW", ...(committed.result === undefined ? {} : { result: committed.result }) };
  if (committed.reason === "VERSION_MISMATCH" || committed.reason === "REVALIDATE") return { accepted: false, decision: "REVALIDATE", reason: committed.reason, ...(committed.observedVersion === undefined ? {} : { observedVersion: committed.observedVersion }) };
  return { accepted: false, decision: "REJECT", reason: committed.reason ?? "COMMIT_REJECTED", ...(committed.observedVersion === undefined ? {} : { observedVersion: committed.observedVersion }) };
}
