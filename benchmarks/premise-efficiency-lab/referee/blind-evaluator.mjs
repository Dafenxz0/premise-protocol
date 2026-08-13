import { createHash } from "node:crypto";

const FORBIDDEN_INPUT_KEYS = new Set([
  "oracle", "truth", "sourceTruth", "expected", "expectedDecision", "expectedOutcome",
  "oracleDecision", "affectedSet", "actualAffectedTarget", "groundTruth", "trueVersion",
  "answerKey", "gold", "label", "labels", "correct", "correctness", "unsafe", "falseBlock",
  "outcome", "actual", "isFresh", "mutation", "mutations", "mutationWindow", "schedule",
  "eventSchedule", "family", "final", "evaluator", "objective", "target", "mapping",
  "candidateName", "candidateMapping", "winner", "ranking", "strategy", "arm", "policy",
  "model", "provider", "systemPrompt", "temperature", "seed", "hiddenLabels"
]);

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

function assertNoOracle(value, path = "input") {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_INPUT_KEYS.has(key)) throw new Error(`oracle leakage at ${path}.${key}`);
    assertNoOracle(nested, `${path}.${key}`);
  }
}

export function anonymizeCandidates(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) throw new RangeError("candidates must not be empty");
  const seed = String(options.seed ?? "premise-blind-referee");
  const mapping = {};
  const publicCandidates = candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || typeof candidate.id !== "string") throw new TypeError("candidate must have an id");
    const blindId = `arm-${digest(`${seed}:${candidate.id}:${index}`).slice(-12)}`;
    mapping[blindId] = candidate.id;
    const { id: _id, ...payload } = candidate;
    assertNoOracle(payload, `candidate[${index}]`);
    return Object.freeze({ blindId, ...payload });
  });
  return Object.freeze({
    publicCandidates: Object.freeze(publicCandidates),
    privateMapping: Object.freeze(mapping),
    mappingDigest: digest(mapping)
  });
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function pass(value) {
  return value === true || value === "PASS";
}

const REFERENCE_FIELDS = Object.freeze(["decision", "coherence", "frontier", "guard", "actionOutcome"]);

function referenceField(value, field) {
  if (value === undefined || value === null) return undefined;
  if (field === "frontier") {
    if (typeof value !== "object") return value;
    return {
      status: value.status,
      roots: Array.isArray(value.roots) ? [...value.roots].sort() : undefined,
      complete: value.complete
    };
  }
  if (field === "actionOutcome") {
    if (typeof value !== "object") return value;
    return { accepted: value.accepted, reason: value.reason ?? null };
  }
  return value;
}

/** Compare candidate-visible normative output with the independent reference. */
export function compareReferenceResult(reference, candidate) {
  const fields = {
    decision: "UNKNOWN",
    coherence: "UNKNOWN",
    frontier: "UNKNOWN",
    guard: "UNKNOWN",
    actionOutcome: "UNKNOWN"
  };
  const pairs = [
    ["decision", reference?.decision, candidate?.decision],
    ["coherence", reference?.coherence, candidate?.coherence],
    ["frontier", reference?.frontier, candidate?.frontier],
    ["guard", reference?.guardDecision, candidate?.guardDecision],
    ["actionOutcome", reference?.actionOutcome, candidate?.actionOutcome]
  ];
  for (const [field, expected, actual] of pairs) {
    const left = referenceField(expected, field);
    const right = referenceField(actual, field);
    if (left === undefined || right === undefined) fields[field] = "UNKNOWN";
    else fields[field] = stableJson(left) === stableJson(right) ? "PASS" : "FAIL";
  }
  const statuses = Object.values(fields);
  const status = statuses.includes("FAIL") ? "FAIL" : statuses.includes("UNKNOWN") ? "UNKNOWN" : "PASS";
  return Object.freeze({ status, fields: Object.freeze(fields) });
}

const V1_GATE_FIELDS = Object.freeze([
  "referenceEquivalent",
  "affectedRecall",
  "unsafeActions",
  "toctouEscapes",
  "staleReceiptReuse",
  "crossTenantReuse",
  "unknownPromotedFresh",
  "invalidReceiptAccepted",
  "authorizationScopeViolations",
  "incarnationViolations",
  "replayViolations",
  "falseBlocks",
  "safeCompletion"
]);

export function evaluateSafetyGates(candidate, options = {}) {
  const missing = V1_GATE_FIELDS.filter((field) => candidate[field] === undefined || candidate[field] === null);
  if (missing.length > 0) return Object.freeze({ eligible: false, missing, failures: [] });
  const failures = [];
  if (!pass(candidate.referenceEquivalent)) failures.push("referenceEquivalent");
  if (candidate.affectedRecall !== 1) failures.push("affectedRecall");
  for (const field of [
    "unsafeActions", "toctouEscapes", "staleReceiptReuse", "crossTenantReuse",
    "unknownPromotedFresh", "invalidReceiptAccepted", "authorizationScopeViolations",
    "incarnationViolations", "replayViolations"
  ]) {
    if (!numeric(candidate[field]) || candidate[field] !== 0) failures.push(field);
  }
  const falseBlockCeiling = options.referenceFalseBlockCeiling ?? 0;
  const safeCompletionFloor = options.referenceSafeCompletionFloor ?? 0;
  if (!numeric(candidate.falseBlocks) || candidate.falseBlocks > falseBlockCeiling) failures.push("falseBlocks");
  if (!numeric(candidate.safeCompletion) || candidate.safeCompletion < safeCompletionFloor) failures.push("safeCompletion");
  return Object.freeze({ eligible: failures.length === 0, missing: [], failures: Object.freeze(failures) });
}

export function evaluateBlind(publicCandidates, options = {}) {
  if (!Array.isArray(publicCandidates) || publicCandidates.length === 0) throw new RangeError("publicCandidates must not be empty");
  const safetyFields = ["unsafeActions", "toctouEscapes", "crossTenantReuse"];
  const unknown = publicCandidates.some((candidate) => safetyFields.some((field) => !numeric(candidate[field])));
  if (unknown) return Object.freeze({ status: "INCONCLUSIVE", reason: "missing safety metric", ranking: [] });
  const enforceSafetyGates = options.enforceSafetyGates === true;
  const gateResults = enforceSafetyGates
    ? publicCandidates.map((candidate) => ({ blindId: candidate.blindId, ...evaluateSafetyGates(candidate, options) }))
    : [];
  if (enforceSafetyGates && gateResults.some((result) => result.missing.length > 0)) {
    return Object.freeze({ status: "INCONCLUSIVE", reason: "missing v1 safety gate metric", ranking: [], gates: Object.freeze(gateResults) });
  }
  const eligibleIds = new Set(gateResults.filter((result) => result.eligible).map((result) => result.blindId));
  const candidatesToRank = enforceSafetyGates ? publicCandidates.filter((candidate) => eligibleIds.has(candidate.blindId)) : publicCandidates;
  if (enforceSafetyGates && candidatesToRank.length === 0) {
    return Object.freeze({ status: "INCONCLUSIVE", reason: "no eligible candidate", ranking: [], gates: Object.freeze(gateResults), eligibleCount: 0 });
  }
  const rankingMode = options.rankingMode ?? "legacy";
  const v1RankingFields = [
    "workPerSafeCompletion",
    "WA_external",
    "WA_graph",
    "WA_validate",
    "WA_write",
    "physicalOperations",
    "latency"
  ];
  const requiredRankingFields = rankingMode === "v1" ? v1RankingFields : ["workPerSafeCompletion"];
  if (candidatesToRank.some((candidate) => requiredRankingFields.some((field) => !numeric(candidate[field])))) {
    return Object.freeze({
      status: "INCONCLUSIVE",
      reason: "missing efficiency metric",
      ranking: [],
      ...(enforceSafetyGates ? { gates: Object.freeze(gateResults), eligibleCount: candidatesToRank.length } : {})
    });
  }
  const ranking = [...candidatesToRank]
    .sort((left, right) => {
      if (rankingMode === "v1") {
        for (const field of requiredRankingFields) {
          if (left[field] !== right[field]) return left[field] - right[field];
        }
        return left.blindId.localeCompare(right.blindId);
      }
      for (const field of safetyFields) {
        if (left[field] !== right[field]) return left[field] - right[field];
      }
      return left.workPerSafeCompletion - right.workPerSafeCompletion || left.blindId.localeCompare(right.blindId);
    })
    .map((candidate, rank) => Object.freeze({
      rank: rank + 1,
      blindId: candidate.blindId,
      unsafeActions: candidate.unsafeActions,
      workPerSafeCompletion: candidate.workPerSafeCompletion ?? "UNKNOWN",
      ...(rankingMode === "v1" ? { rankingMetrics: Object.freeze(Object.fromEntries(requiredRankingFields.map((field) => [field, candidate[field]]))) } : {})
    }));
  return Object.freeze({
    status: "COMPLETE",
    ranking: Object.freeze(ranking),
    ...(enforceSafetyGates ? { gates: Object.freeze(gateResults), eligibleCount: candidatesToRank.length } : {}),
    rule: rankingMode === "v1"
      ? "hard safety gates, then preregistered v1 comparator"
      : enforceSafetyGates ? "hard safety gates, then work per safe completion" : "safety-first, then work per safe completion"
  });
}

export function createSealedManifest(dataset, options = {}) {
  return Object.freeze({
    format: "premise-efficiency-lab/sealed-manifest/0",
    status: "SEALED",
    datasetDigest: digest(dataset),
    seedDigest: digest(String(options.seed ?? "")),
    oracleFieldsExcluded: Object.freeze(["truth", "expectedDecision", "affectedSet", "candidateMapping"]),
    refereeOnly: true
  });
}

export { assertNoOracle };
