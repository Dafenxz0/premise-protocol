import {
  bundleWithPrivateData,
  createPublicFixture,
  identifier,
  resolveOptions,
  token,
  toPublicData
} from "./common.mjs";

export const FIXTURE_TYPE = "receipt-cache-adversarial";
const DEFAULT_SEED = "efficiency-lab-v1-receipt-cache-adversarial";

export const RECEIPT_CACHE_MODES = Object.freeze([
  "stale-replay",
  "cross-tenant-reuse",
  "query-mismatch",
  "causal-frontier-mismatch",
  "incarnation-reuse",
  "negative-entry-poisoning",
  "invalid-proof"
]);
export const RECEIPT_ATTACK_MODES = RECEIPT_CACHE_MODES;

function makeAttempt(options, index, base) {
  const attackMode = RECEIPT_CACHE_MODES[index % RECEIPT_CACHE_MODES.length];
  const alternateTenant = attackMode === "cross-tenant-reuse";
  const queryMismatch = attackMode === "query-mismatch";
  const frontierMismatch = attackMode === "causal-frontier-mismatch";
  const incarnationReuse = attackMode === "incarnation-reuse";
  const tenantId = alternateTenant ? identifier("tenant", options.seed, "alternate-tenant", index) : base.tenantId;
  const queryDigest = queryMismatch ? token(options.seed, "alternate-query", index) : base.queryDigest;
  const frontierDigest = frontierMismatch ? token(options.seed, "alternate-frontier", index) : base.frontierDigest;
  const generationToken = incarnationReuse ? token(options.seed, "old-incarnation", index) : base.generationToken;
  const issuedAt = 1_700_000_000_000 + index * 2_000;
  const expired = attackMode === "stale-replay";
  const malformedProof = attackMode === "invalid-proof";
  const scopeDigest = token(options.seed, "scope", {
    index,
    tenantId,
    queryDigest,
    frontierDigest,
    generationToken
  });
  return {
    attemptId: identifier("attempt", options.seed, "attempt", index),
    sequence: index + 1,
    attackMode,
    cacheOperation: index % 3 === 0 ? "lookup" : index % 3 === 1 ? "insert" : "replay",
    tenantId,
    resourceId: base.resourceId,
    scopeDigest,
    cacheKeyDigest: base.cacheKeyDigest,
    receipt: {
      receiptId: identifier("receipt", options.seed, "receipt", index),
      issuedAt: expired ? issuedAt - options.horizonSteps * 2_000 : issuedAt,
      expiresAt: expired ? issuedAt - 1 : issuedAt + options.horizonSteps * 2_000,
      versionToken: base.versionToken,
      generationToken,
      queryDigest,
      causalFrontierDigest: frontierDigest,
      proofDigest: malformedProof ? `malformed-${token(options.seed, "proof", index)}` : token(options.seed, "proof", index)
    },
    cache: {
      namespaceDigest: token(options.seed, "namespace", alternateTenant ? tenantId : base.tenantId),
      evictionHint: attackMode === "negative-entry-poisoning" ? "negative" : "normal"
    }
  };
}

export function generateReceiptCacheAdversarial(options = {}) {
  const resolved = resolveOptions(options, DEFAULT_SEED);
  const resourceId = identifier("resource", resolved.seed, "resource");
  const base = {
    tenantId: identifier("tenant", resolved.seed, "tenant"),
    resourceId,
    queryDigest: token(resolved.seed, "query"),
    frontierDigest: token(resolved.seed, "frontier"),
    generationToken: token(resolved.seed, "generation"),
    versionToken: `v1-${token(resolved.seed, "version")}`,
    cacheKeyDigest: token(resolved.seed, "cache-key")
  };
  const attempts = Array.from(
    { length: resolved.consumerCount },
    (_, index) => makeAttempt(resolved, index, base)
  );
  return createPublicFixture(FIXTURE_TYPE, resolved, {
    resource: {
      resourceId,
      uri: `source://efficiency-lab/${resourceId}`,
      observedVersion: base.versionToken,
      observedGenerationToken: base.generationToken
    },
    cache: {
      cacheKeyDigest: base.cacheKeyDigest,
      capacity: Math.max(1, Math.min(resolved.consumerCount, 256)),
      namespaceFields: ["tenantId", "resourceId", "queryDigest", "causalFrontierDigest", "generationToken"],
      operations: ["lookup", "insert", "replay", "evict"]
    },
    attempts,
    attackModes: RECEIPT_CACHE_MODES,
    protocol: {
      allowedOperations: ["receipt-lookup", "receipt-validate", "authoritative-read", "conditional-read"],
      scopeFields: ["tenantId", "resourceId", "queryDigest", "causalFrontierDigest", "generationToken"],
      profileHorizonSteps: resolved.horizonSteps
    }
  });
}

export const generateReceiptCacheAdversarialFixture = generateReceiptCacheAdversarial;
export const createReceiptCacheAdversarial = generateReceiptCacheAdversarial;
export const generateReceiptCacheAttack = generateReceiptCacheAdversarial;
export const generateReceiptCacheAttacks = generateReceiptCacheAdversarial;

export function createReceiptCacheAdversarialOracle(fixture) {
  const publicData = toPublicData(fixture);
  return {
    classifications: publicData.attempts.map(({ attackMode }, index) => ({
      attemptId: publicData.attempts[index].attemptId,
      attackMode,
      reusable: false,
      requiresAuthoritativeRead: true
    })),
    staleReceiptRejections: publicData.attempts.filter(({ attackMode }) => attackMode === "stale-replay").length,
    scopeViolations: publicData.attempts.filter(({ attackMode }) => attackMode === "cross-tenant-reuse").length,
    invalidProofs: publicData.attempts.filter(({ attackMode }) => attackMode === "invalid-proof").length
  };
}

export function generateReceiptCacheAdversarialBundle(options = {}) {
  const fixture = generateReceiptCacheAdversarial(options);
  return bundleWithPrivateData(fixture, createReceiptCacheAdversarialOracle(fixture));
}

export const createReceiptCacheAdversarialBundle = generateReceiptCacheAdversarialBundle;
