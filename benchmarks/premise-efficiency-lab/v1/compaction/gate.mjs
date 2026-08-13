export const COMPACTION_GATE_FORMAT = "premise-efficiency-lab/compaction-safety/v1";

export const REQUIRED_COMPACTION_INVARIANTS = Object.freeze([
  Object.freeze({
    id: "semantic-equivalence",
    description: "Compacted and un-compacted histories produce the same observable result.",
    minimumEvidence: "deterministic differential test against an independent oracle"
  }),
  Object.freeze({
    id: "event-continuity",
    description: "Compaction cannot turn gaps, late events, reordering or conflicts into fresh state.",
    minimumEvidence: "deterministic continuity and replay tests"
  }),
  Object.freeze({
    id: "dependency-closure",
    description: "Active records, dependency closure and invalidation/frontier state survive compaction.",
    minimumEvidence: "deterministic graph/frontier equivalence tests"
  }),
  Object.freeze({
    id: "scope-and-incarnation",
    description: "Tenant, resource, authorization, version and incarnation boundaries remain distinct.",
    minimumEvidence: "deterministic cross-scope and incarnation-separation tests"
  }),
  Object.freeze({
    id: "action-replay-safety",
    description: "Stale, replayed and TOCTOU-sensitive actions remain rejected after compaction.",
    minimumEvidence: "deterministic stale-replay and conditional-action tests"
  }),
  Object.freeze({
    id: "crash-atomicity",
    description: "An interrupted compaction recovers to a valid pre- or post-compaction state.",
    minimumEvidence: "deterministic interruption/restart tests"
  }),
  Object.freeze({
    id: "audit-retention",
    description: "Required provenance and security-relevant audit boundaries are not silently discarded.",
    minimumEvidence: "deterministic retention-boundary and audit-preservation tests"
  })
]);

const REQUIRED_IDS = Object.freeze(REQUIRED_COMPACTION_INVARIANTS.map(({ id }) => id));
const ACCEPTED_STATUSES = new Set(["GO", "NO-GO"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidProof(value) {
  return isRecord(value)
    && value.status === "PASS"
    && value.deterministic === true
    && value.independentOracle === true
    && hasText(value.testFile)
    && Number.isSafeInteger(value.testCount)
    && value.testCount > 0;
}

function freezeResult(result) {
  return Object.freeze({
    ...result,
    requiredInvariants: Object.freeze([...result.requiredInvariants]),
    missingInvariants: Object.freeze([...result.missingInvariants]),
    invalidInvariants: Object.freeze([...result.invalidInvariants]),
    reasonCodes: Object.freeze([...result.reasonCodes])
  });
}

export function evaluateCompactionDeclaration(declaration) {
  const input = isRecord(declaration) ? declaration : {};
  const missingInvariants = [];
  const invalidInvariants = [];
  const reasonCodes = new Set();

  if (!isRecord(declaration)) reasonCodes.add("INVALID_DECLARATION");
  if (!ACCEPTED_STATUSES.has(input.status)) reasonCodes.add("STATUS_MISSING_OR_INVALID");
  if (input.status === "GO" && input.compactionImplemented !== true) {
    reasonCodes.add("IMPLEMENTATION_NOT_CONFIRMED");
  }
  if (input.compactionImplemented === true && input.status !== "GO") {
    reasonCodes.add("DECLARATION_NOT_GO");
  }

  const invariants = isRecord(input.invariants) ? input.invariants : {};
  for (const id of REQUIRED_IDS) {
    if (!Object.hasOwn(invariants, id)) {
      missingInvariants.push(id);
    } else if (!isValidProof(invariants[id])) {
      invalidInvariants.push(id);
    }
  }

  if (missingInvariants.length > 0) reasonCodes.add("MISSING_REQUIRED_INVARIANTS");
  if (invalidInvariants.length > 0) reasonCodes.add("INVALID_INVARIANT_EVIDENCE");

  const accepted = input.status === "GO"
    && input.compactionImplemented === true
    && missingInvariants.length === 0
    && invalidInvariants.length === 0;
  if (!accepted && reasonCodes.size === 0) reasonCodes.add("DECLARATION_NOT_ACCEPTED");

  return freezeResult({
    format: COMPACTION_GATE_FORMAT,
    status: accepted ? "GO" : "NO-GO",
    accepted,
    requiredInvariants: REQUIRED_IDS,
    missingInvariants,
    invalidInvariants,
    reasonCodes: [...reasonCodes]
  });
}

export function assertCompactionDeclaration(declaration) {
  const evaluation = evaluateCompactionDeclaration(declaration);
  if (!evaluation.accepted) {
    const error = new Error(`Compaction declaration rejected: ${evaluation.reasonCodes.join(",")}`);
    error.code = "COMPACTION_NO_GO";
    error.evaluation = evaluation;
    throw error;
  }
  return evaluation;
}

export const CURRENT_COMPACTION_DECLARATION = Object.freeze({
  status: "NO-GO",
  compactionImplemented: false,
  invariants: Object.freeze({})
});

export const CURRENT_COMPACTION_EVALUATION = evaluateCompactionDeclaration(CURRENT_COMPACTION_DECLARATION);
