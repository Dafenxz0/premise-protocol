export const REFERENCE_DECISIONS = Object.freeze(["ALLOW", "REVALIDATE", "REJECT", "UNSUPPORTED"]);

function unique(values) {
  return [...new Set(values)];
}

/**
 * Small JavaScript reference for the guard contract. It intentionally mirrors
 * the fail-closed ordering in packages/runtime-core/src/premise-guard.ts so a
 * benchmark candidate can be checked without importing TypeScript sources.
 */
export function referenceDecision({
  actionDigest,
  idempotencyKey,
  criticalPremises,
  requiredCapability,
  capabilities = [],
  receipts = [],
  commit = { accepted: true }
} = {}) {
  if (typeof actionDigest !== "string" || actionDigest.length === 0
    || typeof idempotencyKey !== "string" || idempotencyKey.length === 0
    || !Array.isArray(criticalPremises) || criticalPremises.length === 0) {
    return Object.freeze({ accepted: false, decision: "REJECT", reason: "INVALID_INTENT" });
  }
  if (unique(criticalPremises).length !== criticalPremises.length) {
    return Object.freeze({ accepted: false, decision: "REJECT", reason: "DUPLICATE_PREMISE" });
  }
  if (!capabilities.includes(requiredCapability) || !capabilities.includes("IDEMPOTENCY_KEY")) {
    return Object.freeze({ accepted: false, decision: "UNSUPPORTED", reason: "MISSING_CONDITIONAL_COMMIT" });
  }
  const byPremise = new Map(receipts.map((receipt) => [receipt.premiseId, receipt]));
  for (const premiseId of criticalPremises) {
    const receipt = byPremise.get(premiseId);
    if (receipt === undefined) return Object.freeze({ accepted: false, decision: "REJECT", reason: "INCOMPLETE_SLICE" });
    if (!receipt.valid || receipt.state === "UNKNOWN" || receipt.state === "INVALID") {
      return Object.freeze({ accepted: false, decision: "REJECT", reason: "INVALID_RECEIPT" });
    }
    if (receipt.state === "STALE") return Object.freeze({ accepted: false, decision: "REVALIDATE", reason: "STALE_RECEIPT" });
  }
  if (commit.accepted) return Object.freeze({ accepted: true, decision: "ALLOW" });
  if (commit.reason === "VERSION_MISMATCH" || commit.reason === "REVALIDATE") {
    return Object.freeze({ accepted: false, decision: "REVALIDATE", reason: commit.reason });
  }
  return Object.freeze({ accepted: false, decision: "REJECT", reason: commit.reason ?? "COMMIT_REJECTED" });
}
