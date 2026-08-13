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
  if (candidatesToRank.some((candidate) => !numeric(candidate.workPerSafeCompletion))) {
    return Object.freeze({
      status: "INCONCLUSIVE",
      reason: "missing efficiency metric",
      ranking: [],
      ...(enforceSafetyGates ? { gates: Object.freeze(gateResults), eligibleCount: candidatesToRank.length } : {})
    });
  }
  const ranking = [...candidatesToRank]
    .sort((left, right) => {
      for (const field of safetyFields) {
        if (left[field] !== right[field]) return left[field] - right[field];
      }
      const leftWork = numeric(left.workPerSafeCompletion) ? left.workPerSafeCompletion : Number.POSITIVE_INFINITY;
      const rightWork = numeric(right.workPerSafeCompletion) ? right.workPerSafeCompletion : Number.POSITIVE_INFINITY;
      return leftWork - rightWork || left.blindId.localeCompare(right.blindId);
    })
    .map((candidate, rank) => Object.freeze({ rank: rank + 1, blindId: candidate.blindId, unsafeActions: candidate.unsafeActions, workPerSafeCompletion: candidate.workPerSafeCompletion ?? "UNKNOWN" }));
  return Object.freeze({
    status: "COMPLETE",
    ranking: Object.freeze(ranking),
    ...(enforceSafetyGates ? { gates: Object.freeze(gateResults), eligibleCount: candidatesToRank.length } : {}),
    rule: enforceSafetyGates ? "hard safety gates, then work per safe completion" : "safety-first, then work per safe completion"
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
