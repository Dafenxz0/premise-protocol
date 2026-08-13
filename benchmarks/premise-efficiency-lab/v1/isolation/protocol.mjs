import { canonicalJson } from "./hash.mjs";

export const ISOLATION_PROTOCOL = "premise-efficiency-lab/isolation/v1";
export const PROTOCOL_FORMAT = ISOLATION_PROTOCOL;
export const MAX_NDJSON_LINE_BYTES = 1 * 1024 * 1024;
export const MAX_NDJSON_RECORDS = 10_000;
export const DECISIONS = Object.freeze(["USE", "VALIDATE", "REJECT", "ACTION"]);

const FORBIDDEN_NAMES = Object.freeze([
  "oracle",
  "truth",
  "sourceTruth",
  "expected",
  "expectedDecision",
  "expectedOutcome",
  "oracleDecision",
  "affectedSet",
  "actualAffectedTarget",
  "groundTruth",
  "trueVersion",
  "candidateName",
  "mapping",
  "candidateMapping",
  "hiddenLabels",
  "hiddenLabel",
  "oracleLabel",
  "oracleLabels",
  "oracleResult",
  "privateOracle",
  "answerKey",
  "gold",
  "label",
  "labels",
  "correct",
  "correctness",
  "unsafe",
  "falseBlock",
  "outcome",
  "actual",
  "isFresh",
  "mutation",
  "mutations",
  "mutationWindow",
  "schedule",
  "eventSchedule",
  "family",
  "final",
  "evaluator",
  "objective",
  "target",
  "winner",
  "ranking",
  "strategy",
  "arm",
  "policy",
  "model",
  "provider",
  "systemPrompt",
  "temperature",
  "seed",
  "answer",
  "private",
  "privatePayload",
  "privateData"
]);

function normalizeKey(key) {
  return key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
}

const FORBIDDEN_NORMALIZED = new Set(FORBIDDEN_NAMES.map(normalizeKey));

export const FORBIDDEN_FIELD_NAMES = Object.freeze([...FORBIDDEN_NAMES]);
export const FORBIDDEN_KEYS = FORBIDDEN_NORMALIZED;

export class IsolationProtocolError extends Error {
  constructor(message, code = "ISOLATION_PROTOCOL_INVALID") {
    super(`[efficiency-lab-isolation] ${message}`);
    this.name = "IsolationProtocolError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new IsolationProtocolError(message, code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function assertString(value, label, { maxLength = 16_384, allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail(`${label} must be a ${allowEmpty ? "string" : "non-empty string"}`);
  if (value.length > maxLength) fail(`${label} exceeds ${maxLength} characters`);
  return value;
}

function assertJsonValue(value, label = "value", stack = new Set()) {
  try {
    canonicalJson(value);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, "INVALID_JSON_VALUE");
  }
  return value;
}

function collectForbidden(value, path, result, stack) {
  if (value === null || typeof value !== "object") return;
  if (stack.has(value)) fail(`cyclic value at ${path}`, "CYCLIC_VALUE");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((child, index) => collectForbidden(child, `${path}[${index}]`, result, stack));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_NORMALIZED.has(normalizeKey(key))) result.push({ path: `${path}.${key}`, key });
      collectForbidden(child, `${path}.${key}`, result, stack);
    }
  } finally {
    stack.delete(value);
  }
}

/** Find every forbidden key, including keys nested in every plan/trace array. */
export function findForbiddenFields(value, path = "$") {
  assertJsonValue(value, path);
  const result = [];
  collectForbidden(value, path, result, new Set());
  return result;
}

export function assertNoForbiddenFields(value, path = "$") {
  const found = findForbiddenFields(value, path);
  if (found.length > 0) {
    fail(`forbidden evaluator field at ${found.map(({ path: fieldPath }) => fieldPath).join(", ")}`, "FORBIDDEN_FIELD");
  }
  return value;
}

export const assertNoOracle = assertNoForbiddenFields;
export const assertPlanPublic = assertNoForbiddenFields;

export function validatePublicPayload(value, label = "public payload") {
  assertRecord(value, label);
  assertNoForbiddenFields(value, label);
  return value;
}

function validateDecision(value, label) {
  if (typeof value !== "string" || !DECISIONS.includes(value)) {
    fail(`${label} must be one of ${DECISIONS.join(", ")}`);
  }
  return value;
}

/** Validate the public candidate plan, including every nested plan field. */
export function validateCandidatePlan(value, label = "plan") {
  assertRecord(value, label);
  assertNoForbiddenFields(value, label);
  assertJsonValue(value, label);
  validateDecision(value.decision, `${label}.decision`);
  if (Object.hasOwn(value, "taskId")) assertString(value.taskId, `${label}.taskId`, { maxLength: 512 });
  if (Object.hasOwn(value, "action")) assertRecord(value.action, `${label}.action`);
  if (Object.hasOwn(value, "receipts")) {
    if (!Array.isArray(value.receipts)) fail(`${label}.receipts must be an array`);
  }
  if (Object.hasOwn(value, "operations") && !Array.isArray(value.operations)) fail(`${label}.operations must be an array`);
  if (Object.hasOwn(value, "trace")) assertRecord(value.trace, `${label}.trace`);
  return value;
}

export function validateCandidateInputRecord(value, label = "candidate input") {
  const record = assertRecord(value, label);
  assertNoForbiddenFields(record, label);
  if (record.protocol !== ISOLATION_PROTOCOL) fail(`${label}.protocol must be ${ISOLATION_PROTOCOL}`);
  if (record.type !== "task") fail(`${label}.type must be task`);
  if (Object.hasOwn(record, "taskId")) assertString(record.taskId, `${label}.taskId`, { maxLength: 512 });
  validatePublicPayload(record.public, `${label}.public`);
  if (Object.hasOwn(record, "private")) fail(`${label}.private must never cross the candidate boundary`, "PRIVATE_PAYLOAD_LEAK");
  return record;
}

export function validateCandidateOutputRecord(value, label = "candidate output") {
  const record = assertRecord(value, label);
  assertNoForbiddenFields(record, label);
  assertJsonValue(record, label);

  if (!Object.hasOwn(record, "type")) return validateCandidatePlan(record, label);
  assertString(record.type, `${label}.type`, { maxLength: 64 });
  if (Object.hasOwn(record, "protocol") && record.protocol !== ISOLATION_PROTOCOL) {
    fail(`${label}.protocol must be ${ISOLATION_PROTOCOL}`);
  }
  switch (record.type) {
    case "plan":
    case "result":
      return validateCandidatePlan(record.plan ?? record, `${label}.plan`);
    case "receipt":
      if (!Object.hasOwn(record, "receipt")) fail(`${label}.receipt is required`);
      return record;
    case "trace":
      if (!isRecord(record.trace)) fail(`${label}.trace must be an object`);
      return record;
    case "done":
      return record;
    case "error":
      assertString(record.message, `${label}.message`, { maxLength: 4_096 });
      fail(`${label} reported a candidate error`, "CANDIDATE_ERROR");
      break;
    default:
      fail(`${label}.type ${record.type} is not supported`);
  }
}

function lineBytes(line) {
  return Buffer.byteLength(line, "utf8");
}

export function encodeNdjson(value, { maxLineBytes = MAX_NDJSON_LINE_BYTES, validate = undefined } = {}) {
  assertRecord(value, "NDJSON record");
  assertJsonValue(value, "NDJSON record");
  if (typeof validate === "function") validate(value, "NDJSON record");
  const line = canonicalJson(value);
  if (lineBytes(line) > maxLineBytes) fail(`NDJSON record exceeds ${maxLineBytes} bytes`, "LINE_TOO_LARGE");
  return `${line}\n`;
}

export function parseNdjsonLine(line, { maxLineBytes = MAX_NDJSON_LINE_BYTES, validate = undefined } = {}) {
  if (typeof line !== "string") throw new TypeError("NDJSON line must be a string");
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (normalized.length === 0 || normalized.trim().length === 0) fail("blank NDJSON lines are not allowed", "BLANK_LINE");
  if (lineBytes(normalized) > maxLineBytes) fail(`NDJSON line exceeds ${maxLineBytes} bytes`, "LINE_TOO_LARGE");
  let value;
  try {
    value = JSON.parse(normalized);
  } catch (error) {
    fail(`invalid NDJSON JSON: ${error instanceof Error ? error.message : String(error)}`, "INVALID_JSON");
  }
  assertRecord(value, "NDJSON record");
  if (typeof validate === "function") validate(value, "NDJSON record");
  return value;
}

export function parseNdjson(text, {
  maxLineBytes = MAX_NDJSON_LINE_BYTES,
  maxRecords = MAX_NDJSON_RECORDS,
  validate = undefined,
  requireCanonical = false
} = {}) {
  if (typeof text !== "string") throw new TypeError("NDJSON input must be a string");
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > maxRecords) fail(`NDJSON input exceeds ${maxRecords} records`, "TOO_MANY_RECORDS");
  return lines.map((line, index) => {
    const value = parseNdjsonLine(line, { maxLineBytes, validate });
    if (requireCanonical) {
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (canonicalJson(value) !== normalized) fail(`NDJSON record ${index} is not canonical JSON`, "NON_CANONICAL_JSON");
    }
    return value;
  });
}

export const decodeNdjson = parseNdjson;
export const validateNdjson = parseNdjson;
