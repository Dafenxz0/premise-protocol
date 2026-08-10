import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { isIP } from "node:net";

export const HOLDOUT_MANIFEST_FORMAT = "premise-ga-holdout-manifest/1";
export const HOLDOUT_TASKS_FORMAT = "premise-ga-holdout-tasks/1";
export const HOLDOUT_LABELS_FORMAT = "premise-ga-holdout-labels/1";
export const HOLDOUT_ATTESTATION_FORMAT = "premise-ga-holdout-attestation/1";
export const HOLDOUT_PROTOCOL = "premise-ga-holdout/1";
export const HOLDOUT_RUNNER_VERSION = "premise-ga-holdout-runner/1.0.0";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const FORBIDDEN_KEYS = new Set([
  "answer",
  "answers",
  "correct",
  "expected",
  "gold",
  "goldAnswer",
  "label",
  "labels",
  "oracle",
  "truth"
]);

export class HoldoutContractError extends Error {
  constructor(message, code = "HOLDOUT_CONTRACT_INVALID") {
    super(`[ga-holdout] ${message}`);
    this.name = "HoldoutContractError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new HoldoutContractError(message, code);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function requireString(value, label, { maxLength = 2048 } = {}) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  if (value.length > maxLength) fail(`${label} exceeds ${maxLength} characters`);
  return value;
}

function requirePositiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) fail(`${label} must be an integer between 1 and ${maximum}`);
  return value;
}

function isPrivateIp(hostname) {
  if (isIP(hostname) === 4) {
    const octets = hostname.split(".").map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
  }
  if (isIP(hostname) === 6) {
    const normalized = hostname.toLowerCase();
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  return false;
}

export function isFixtureReference(value) {
  return typeof value === "string" && /(?:^|[./:\\])fixture(?:[./:\\]|$)/iu.test(value);
}

export function assertExternalUrl(value, label = "external URL") {
  const raw = requireString(value, label, { maxLength: 8192 });
  if (isFixtureReference(raw) || /^(?:file|fixture|data|blob):/iu.test(raw)) fail(`${label} cannot use a local or fixture scheme`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "https:") fail(`${label} must use https`);
  if (parsed.username || parsed.password) fail(`${label} must not contain URL credentials`);
  if (parsed.hostname === "localhost" || parsed.hostname.endsWith(".local") || isPrivateIp(parsed.hostname)) fail(`${label} cannot target a local or private host`);
  return parsed;
}

export function safeExternalUrl(value) {
  const parsed = assertExternalUrl(value);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function stableJson(value) {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) fail("cannot canonicalize undefined or non-JSON value");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Text(value) {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

export function sha256Json(value) {
  return sha256Text(stableJson(value));
}

export function assertSha256(value, label = "sha256") {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function assertNoLocalOrFixtureFields(value, path = "value") {
  if (typeof value === "string") {
    if (isFixtureReference(value) || /^(?:file|fixture|data|blob):/iu.test(value)) fail(`local or fixture reference at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoLocalOrFixtureFields(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) assertNoLocalOrFixtureFields(entry, `${path}.${key}`);
  }
}

function assertNoForbiddenKeys(value, path = "value") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail(`answer-key field ${path}.${key} is forbidden in the blind task set`);
    assertNoForbiddenKeys(entry, `${path}.${key}`);
  }
}

function assertAllowedKeys(value, allowed, path) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key} is not allowed by the holdout contract`);
}

function validateBlobReference(value, label, { sealed = false } = {}) {
  const reference = requireObject(value, label);
  assertAllowedKeys(reference, new Set(["url", "sha256", "mediaType", "immutable", "sealed"]), label);
  assertExternalUrl(reference.url, `${label}.url`);
  assertSha256(reference.sha256, `${label}.sha256`);
  if (reference.mediaType !== "application/json") fail(`${label}.mediaType must be application/json`);
  if (reference.immutable !== true) fail(`${label}.immutable must be true; mutable URLs are not eligible`);
  if (sealed && reference.sealed !== true) fail(`${label}.sealed must be true`);
  return reference;
}

export function validateManifest(manifest) {
  const value = requireObject(manifest, "manifest");
  if (value.format !== HOLDOUT_MANIFEST_FORMAT) fail(`manifest.format must be ${HOLDOUT_MANIFEST_FORMAT}`);
  requireString(value.version, "manifest.version", { maxLength: 32 });
  assertAllowedKeys(value, new Set(["format", "version", "campaign", "source", "dataset", "independence", "limits", "thresholds"]), "manifest");
  assertNoLocalOrFixtureFields(value, "manifest");

  const campaign = requireObject(value.campaign, "manifest.campaign");
  assertAllowedKeys(campaign, new Set(["id", "split", "kind", "publisher", "createdAt"]), "manifest.campaign");
  if (!ID_PATTERN.test(requireString(campaign.id, "manifest.campaign.id", { maxLength: 128 }))) fail("manifest.campaign.id has invalid characters");
  if (campaign.split !== "holdout") fail("manifest.campaign.split must be holdout");
  if (campaign.kind !== "external-blind") fail("manifest.campaign.kind must be external-blind");
  requireString(campaign.publisher, "manifest.campaign.publisher", { maxLength: 256 });
  requireString(campaign.createdAt, "manifest.campaign.createdAt", { maxLength: 64 });

  const source = requireObject(value.source, "manifest.source");
  assertAllowedKeys(source, new Set(["adapter", "apiBase", "repository", "readOnly"]), "manifest.source");
  if (source.adapter !== "github") fail("manifest.source.adapter must be github for this runner");
  const apiBase = assertExternalUrl(source.apiBase, "manifest.source.apiBase");
  if (apiBase.search || apiBase.hash) fail("manifest.source.apiBase must not contain a query or fragment");
  if (!REPOSITORY_PATTERN.test(requireString(source.repository, "manifest.source.repository", { maxLength: 204 }))) fail("manifest.source.repository must be owner/repository");
  if (source.readOnly !== true) fail("manifest.source.readOnly must be true");

  const dataset = requireObject(value.dataset, "manifest.dataset");
  assertAllowedKeys(dataset, new Set(["tasks", "labels"]), "manifest.dataset");
  const tasks = validateBlobReference(dataset.tasks, "manifest.dataset.tasks");
  const labels = validateBlobReference(dataset.labels, "manifest.dataset.labels", { sealed: true });
  if (tasks.url === labels.url) fail("task and label URLs must be different to preserve blindness");
  if (tasks.sha256 === labels.sha256) fail("task and label hashes must be different to preserve separation");

  const independence = requireObject(value.independence, "manifest.independence");
  assertAllowedKeys(independence, new Set(["required", "labelsSealed", "separateRunner", "candidateEvidenceAllowed"]), "manifest.independence");
  if (independence.required !== true) fail("manifest.independence.required must be true for a GA holdout");
  if (independence.labelsSealed !== true) fail("manifest.independence.labelsSealed must be true");
  if (independence.separateRunner !== true) fail("manifest.independence.separateRunner must be true");
  if (independence.candidateEvidenceAllowed !== true) fail("manifest.independence.candidateEvidenceAllowed must be true so non-independent runs remain explicitly classified");

  const limits = value.limits === undefined ? {} : requireObject(value.limits, "manifest.limits");
  assertAllowedKeys(limits, new Set(["maxTasks", "maxPayloadBytes", "taskTimeoutMs"]), "manifest.limits");
  const maxTasks = requirePositiveInteger(limits.maxTasks ?? 1000, "manifest.limits.maxTasks", 100_000);
  const maxPayloadBytes = requirePositiveInteger(limits.maxPayloadBytes ?? 4 * 1024 * 1024, "manifest.limits.maxPayloadBytes", 64 * 1024 * 1024);
  const taskTimeoutMs = requirePositiveInteger(limits.taskTimeoutMs ?? 120_000, "manifest.limits.taskTimeoutMs", 15 * 60 * 1000);
  const thresholds = value.thresholds === undefined ? {} : requireObject(value.thresholds, "manifest.thresholds");
  assertAllowedKeys(thresholds, new Set(["accuracyMin", "freshnessMin"]), "manifest.thresholds");
  const accuracyMin = thresholds.accuracyMin ?? 0.95;
  const freshnessMin = thresholds.freshnessMin ?? 0.99;
  if (typeof accuracyMin !== "number" || !Number.isFinite(accuracyMin) || accuracyMin < 0 || accuracyMin > 1) fail("manifest.thresholds.accuracyMin must be between 0 and 1");
  if (typeof freshnessMin !== "number" || !Number.isFinite(freshnessMin) || freshnessMin < 0 || freshnessMin > 1) fail("manifest.thresholds.freshnessMin must be between 0 and 1");
  return {
    ...value,
    limits: { maxTasks, maxPayloadBytes, taskTimeoutMs },
    thresholds: { accuracyMin, freshnessMin }
  };
}

function opaqueId(prefix, value) {
  return `${prefix}-${sha256Text(value).slice(0, 24)}`;
}

function validateGithubPath(path, repository, label) {
  requireString(path, `${label}.path`, { maxLength: 2048 });
  const repositoryPrefix = `/repos/${repository}`;
  if (path !== repositoryPrefix && !path.startsWith(`${repositoryPrefix}/`)) fail(`${label}.path must stay inside the manifest repository`);
  if (path.includes("\\") || /(?:^|\/)\.\.(?:\/|$)/u.test(path) || /%2e/iu.test(path) || path.includes("#") || /[\r\n]/u.test(path)) fail(`${label}.path contains an unsafe GitHub route`);
  const parsed = new URL(path, "https://github.invalid");
  if (parsed.origin !== "https://github.invalid" || parsed.pathname !== path.split("?")[0]) fail(`${label}.path must be a relative GitHub API path`);
  return path;
}

export function validateTaskSet(taskSet, manifest) {
  const value = requireObject(taskSet, "task set");
  if (value.format !== HOLDOUT_TASKS_FORMAT) fail(`task set.format must be ${HOLDOUT_TASKS_FORMAT}`);
  requireString(value.version, "task set.version", { maxLength: 32 });
  assertAllowedKeys(value, new Set(["format", "version", "tasks"]), "task set");
  assertNoLocalOrFixtureFields(value, "task set");
  assertNoForbiddenKeys(value, "task set");
  if (!Array.isArray(value.tasks) || value.tasks.length < 1) fail("task set.tasks must be a non-empty array");
  if (value.tasks.length > manifest.limits.maxTasks) fail(`task set contains more than ${manifest.limits.maxTasks} tasks`);
  const ids = new Set();
  const tasks = value.tasks.map((task, index) => {
    const label = `task[${index}]`;
    const item = requireObject(task, label);
    assertAllowedKeys(item, new Set(["id", "prompt", "source"]), label);
    const id = requireString(item.id, `${label}.id`, { maxLength: 128 });
    if (!ID_PATTERN.test(id)) fail(`${label}.id has invalid characters`);
    if (ids.has(id)) fail(`duplicate task id ${id}`);
    ids.add(id);
    requireString(item.prompt, `${label}.prompt`, { maxLength: 16_384 });
    const source = requireObject(item.source, `${label}.source`);
    assertAllowedKeys(source, new Set(["id", "adapter", "method", "path"]), `${label}.source`);
    const sourceId = requireString(source.id, `${label}.source.id`, { maxLength: 128 });
    if (!ID_PATTERN.test(sourceId)) fail(`${label}.source.id has invalid characters`);
    if (source.adapter !== "github") fail(`${label}.source.adapter must be github`);
    if (source.method !== "GET") fail(`${label}.source.method must be GET; the holdout adapter is read-only`);
    const path = validateGithubPath(source.path, manifest.source.repository, `${label}.source`);
    return Object.freeze({ id, prompt: item.prompt, source: Object.freeze({ id: sourceId, adapter: "github", method: "GET", path }) });
  });
  return { ...value, tasks, taskIds: ids };
}

export function validateLabelSet(labelSet, taskSet) {
  const value = requireObject(labelSet, "label set");
  if (value.format !== HOLDOUT_LABELS_FORMAT) fail(`label set.format must be ${HOLDOUT_LABELS_FORMAT}`);
  requireString(value.version, "label set.version", { maxLength: 32 });
  assertAllowedKeys(value, new Set(["format", "version", "labels"]), "label set");
  if (!Array.isArray(value.labels) || value.labels.length !== taskSet.tasks.length) fail("label set must contain exactly one label per task");
  const labels = new Map();
  for (const [index, label] of value.labels.entries()) {
    const item = requireObject(label, `label[${index}]`);
    assertAllowedKeys(item, new Set(["taskId", "answer", "sourceVersion"]), `label[${index}]`);
    const taskId = requireString(item.taskId, `label[${index}].taskId`, { maxLength: 128 });
    if (!taskSet.taskIds.has(taskId)) fail(`label[${index}] references an unknown task`);
    if (labels.has(taskId)) fail(`duplicate label for ${taskId}`);
    if (!Object.hasOwn(item, "answer")) fail(`label[${index}] must contain answer; labels remain unavailable to the candidate`);
    if (Object.hasOwn(item, "sourceVersion")) requireString(item.sourceVersion, `label[${index}].sourceVersion`, { maxLength: 512 });
    labels.set(taskId, Object.freeze({ taskId, answer: item.answer, ...(Object.hasOwn(item, "sourceVersion") ? { sourceVersion: item.sourceVersion } : {}) }));
  }
  for (const task of taskSet.tasks) if (!labels.has(task.id)) fail(`label set is missing ${task.id}`);
  return { ...value, labels, labelIds: new Set(labels.keys()) };
}

export function publicTask(task) {
  const publicValue = {
    protocol: HOLDOUT_PROTOCOL,
    taskId: opaqueId("task", task.id),
    prompt: task.prompt,
    source: {
      id: opaqueId("source", task.source.id),
      adapter: "github"
    },
    capabilities: ["read", "version"]
  };
  const serialized = JSON.stringify(publicValue);
  for (const forbidden of ["oracle", "snapshot", "expected", "gold", "answer", "label"]) if (serialized.includes(`\"${forbidden}\"`)) fail(`public task leaks ${forbidden}`);
  return publicValue;
}

export function normalizeAnswer(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  return JSON.parse(stableJson(value));
}

export function answersEqual(left, right) {
  return stableJson(normalizeAnswer(left)) === stableJson(normalizeAnswer(right));
}

export function answerDigest(value) {
  return sha256Json(normalizeAnswer(value));
}

export function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

export function candidateCommitFromEnvironment(environment = process.env) {
  const value = environment.PREMISE_CANDIDATE_COMMIT ?? environment.GITHUB_SHA;
  return typeof value === "string" && COMMIT_PATTERN.test(value) ? value : undefined;
}

export function verifyIndependentAttestation(attestation, expected, publicKeyPem) {
  const value = requireObject(attestation, "independent attestation");
  if (value.format !== HOLDOUT_ATTESTATION_FORMAT) fail(`attestation.format must be ${HOLDOUT_ATTESTATION_FORMAT}`);
  if (value.status !== "independent") fail("attestation.status must be independent");
  const signature = requireString(value.signature, "attestation.signature", { maxLength: 4096 });
  const requiredMatches = ["manifestSha256", "taskSetSha256", "labelSetSha256", "responsesSha256", "runSha256", "candidateCommit"];
  for (const field of requiredMatches) if (value[field] !== expected[field]) fail(`attestation.${field} does not match this run`);
  requireString(value.independentRunnerId, "attestation.independentRunnerId", { maxLength: 256 });
  requireString(value.evaluatorId, "attestation.evaluatorId", { maxLength: 256 });
  if (value.labelsAccessedAfterResponses !== true) fail("attestation must state that labels were accessed after candidate responses");
  if (value.sourceReadOnly !== true) fail("attestation must state that all connector requests were read-only");
  if (value.fixturesUsed !== false) fail("attestation must state that fixtures were not used");
  if (typeof publicKeyPem !== "string" || publicKeyPem.length === 0) fail("independent attestation verification requires a configured public key", "HOLDOUT_NOT_ELIGIBLE");
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    fail("configured independent attestation public key is invalid", "HOLDOUT_NOT_ELIGIBLE");
  }
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(signature, "base64");
  } catch {
    fail("attestation.signature is not valid base64");
  }
  const { signature: ignored, ...payload } = value;
  let valid = false;
  try {
    valid = verifySignature(null, Buffer.from(stableJson(payload), "utf8"), key, signatureBytes);
  } catch {
    valid = false;
  }
  if (!valid) fail("independent attestation signature is invalid", "HOLDOUT_NOT_ELIGIBLE");
  return { verified: true, evaluatorId: value.evaluatorId, independentRunnerId: value.independentRunnerId };
}

export function assertCandidateMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") fail("candidate message must be an object with a type");
  if (message.type === "answer") {
    if (!Object.hasOwn(message, "answer")) fail("candidate answer must contain answer");
    const decision = message.decision ?? "USE";
    if (!["USE", "REJECT", "REVALIDATE"].includes(decision)) fail(`unsupported candidate decision ${decision}`);
  } else if (!["read", "version", "log"].includes(message.type)) {
    fail(`unsupported candidate message type ${message.type}`);
  }
  return message;
}

export function validateExternalManifestInput({ manifestUrl, manifestSha256, candidateCommand }) {
  if (typeof manifestUrl !== "string" || manifestUrl.length === 0) fail("PREMISE_HOLDOUT_MANIFEST_URL or --manifest-url is required", "HOLDOUT_NOT_ELIGIBLE");
  if (typeof manifestSha256 !== "string" || manifestSha256.length === 0) fail("PREMISE_HOLDOUT_MANIFEST_SHA256 or --manifest-sha256 is required", "HOLDOUT_NOT_ELIGIBLE");
  assertExternalUrl(manifestUrl, "holdout manifest URL");
  assertSha256(manifestSha256, "holdout manifest SHA-256");
  if (typeof candidateCommand !== "string" || candidateCommand.trim().length === 0) fail("--candidate or PREMISE_HOLDOUT_CANDIDATE is required", "HOLDOUT_NOT_ELIGIBLE");
  return true;
}
