import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const BENCHMARK_DIR = new URL("../", import.meta.url);
export const CAMPAIGN_MANIFEST_URL = new URL("../manifest/v1.json", import.meta.url);
export const DATASET_MANIFEST_URL = new URL("../datasets/v1.json", import.meta.url);
export const PROMPT_MANIFEST_URL = new URL("../prompts/v1.json", import.meta.url);
export const LABEL_MANIFEST_URL = new URL("../labels/v1.json", import.meta.url);
export const TASK_MANIFEST_URL = PROMPT_MANIFEST_URL;
export const OUTPUT_DIR_URL = new URL("../outputs/", import.meta.url);
export const PROTOCOL_VERSION = "ga-evaluation/1";
export const RESULT_FORMAT = "ga-evaluation-result/2";
export const RUNNER_VERSION = "ga-evaluation-runner/1.1.0";

const PUBLIC_DOWNLOAD_HEADERS = {
  accept: "application/octet-stream",
  "user-agent": "premise-ga-evaluation/1.0"
};

export const COST_MODEL = Object.freeze({
  currency: "USD",
  perRequestUsd: Object.freeze({ github: 0.00001, filesystem: 0.0000005, git: 0.000005 }),
  computePerMsUsd: 0.00000002,
  note: "Source-operation proxy; excludes model tokens, provider billing, bandwidth, and human review."
});

const SYNTHETIC_MARKER_PATTERN = /(?:^|[/:._-])(?:fixture|synthetic|mock|fake|dummy)(?:[/:._-]|$)/iu;

function syntheticMarkers(value, path = "manifest", found = []) {
  if (typeof value === "string") {
    if (/\.(?:syntheticMarkers|forbiddenSchemes)\[\d+\]$/u.test(path)) return found;
    if (SYNTHETIC_MARKER_PATTERN.test(value)) found.push({ path, value });
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => syntheticMarkers(entry, `${path}[${index}]`, found));
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) syntheticMarkers(entry, `${path}.${key}`, found);
  }
  return found;
}

export function detectSyntheticMarkers(value) {
  return syntheticMarkers(value);
}

function fail(message) {
  throw new Error(`[ga-evaluation] ${message}`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function isFixtureReference(value) {
  return typeof value === "string" && /(?:^|[/:\\])fixture(?:[/:\\]|$)/iu.test(value);
}

function isPublicUrl(value, allowedHosts = ["raw.githubusercontent.com", "github.com"]) {
  if (isFixtureReference(value)) fail(`fixture reference is forbidden as external evidence: ${value}`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`invalid external URL: ${value}`);
  }
  if (parsed.protocol !== "https:") fail(`external evidence must use https: ${value}`);
  if (!allowedHosts.includes(parsed.hostname)) fail(`external evidence host is not allowlisted: ${parsed.hostname}`);
  if (parsed.username || parsed.password) fail(`external evidence URL must not contain credentials: ${value}`);
  return parsed;
}

function assertNoFixtureFields(value, path = "manifest") {
  if (typeof value === "string") {
    if (/\.evidencePolicy\.(?:forbiddenSchemes|syntheticMarkers)\[/u.test(path)) return;
    if (isFixtureReference(value)) fail(`fixture value is forbidden at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoFixtureFields(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) assertNoFixtureFields(entry, `${path}.${key}`);
  }
}

export function assertExternalEvidence(evidence) {
  if (!evidence || evidence.kind !== "external" || evidence.origin !== "public-download") fail("only verified public-download evidence may be presented as external evidence");
  if (evidence.evidenceClass !== undefined && evidence.evidenceClass !== "external-public-static") fail("external evidence has an unsupported evidence class");
  if (evidence.syntheticData !== false) fail("external evidence must explicitly exclude synthetic data");
  isPublicUrl(evidence.downloadUrl);
  if (!/^[a-f0-9]{64}$/u.test(evidence.sha256)) fail("external evidence must carry a verified sha256");
  if (isFixtureReference(evidence.datasetId) || isFixtureReference(evidence.sourceUri)) fail("fixture evidence cannot be promoted to external evidence");
  return evidence;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function answerDigest(value) {
  return sha256(stableJson(normalizeAnswer(value)));
}

export function normalizeAnswer(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "boolean" || typeof value === "number" || value === null) return value;
  return JSON.parse(stableJson(value));
}

export function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function safePathPart(value) {
  return value.replace(/[^a-z0-9._-]+/giu, "_").slice(0, 100);
}

function validGitPath(value) {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.split("/").includes("..") && !value.includes("\\");
}

export function validateDatasetManifest(manifest) {
  if (manifest?.format !== "ga-evaluation-dataset-manifest/1") fail("unexpected dataset manifest format");
  requireString(manifest.version, "dataset manifest version");
  if (manifest.hash !== "sha256") fail("dataset manifest must use sha256");
  if (!Array.isArray(manifest.datasets) || manifest.datasets.length < 1) fail("dataset manifest must contain datasets");
  assertNoFixtureFields(manifest, "datasets");
  if (manifest.evidencePolicy?.syntheticDataAllowed !== false) fail("dataset evidence policy must reject synthetic data");
  if (detectSyntheticMarkers(manifest).length > 0) fail("dataset manifest contains a synthetic or fixture marker");
  const ids = new Set();
  for (const [index, dataset] of manifest.datasets.entries()) {
    const label = `dataset[${index}]`;
    const id = requireString(dataset.id, `${label}.id`);
    if (ids.has(id)) fail(`duplicate dataset id: ${id}`);
    ids.add(id);
    requireString(dataset.sourceId, `${label}.sourceId`);
    if (!["github", "filesystem", "git"].includes(dataset.adapter)) fail(`${label}.adapter must be github, filesystem, or git`);
    requireString(dataset.sourceUri, `${label}.sourceUri`);
    if (dataset.evidenceClass !== "external-public-static") fail(`${label}.evidenceClass must be external-public-static`);
    if (dataset.syntheticData !== false) fail(`${label}.syntheticData must be false`);
    isPublicUrl(dataset.downloadUrl, manifest.evidencePolicy.allowedDownloadHosts);
    if (!/^[a-f0-9]{64}$/u.test(dataset.sha256)) fail(`${label}.sha256 must be a lowercase 64-character digest`);
    if (!/^[0-9a-f]{40}$/u.test(dataset.commit)) fail(`${label}.commit must be a full commit id`);
    if (!validGitPath(dataset.path)) fail(`${label}.path is not a safe Git path`);
    if (dataset.adapter === "git") isPublicUrl(dataset.repositoryUrl, ["github.com"]);
  }
  return { ...manifest, datasetIds: ids };
}

const ALLOWED_ORACLES = new Set(["regex", "regexBoolean", "contains", "trimmedText"]);

function validateOracle(oracle, label) {
  if (!oracle || !ALLOWED_ORACLES.has(oracle.kind)) fail(`${label}.oracle kind is unsupported`);
  if (["regex", "regexBoolean"].includes(oracle.kind)) {
    requireString(oracle.pattern, `${label}.oracle.pattern`);
    new RegExp(oracle.pattern, oracle.flags ?? "u");
    if (oracle.kind === "regex" && !Number.isInteger(oracle.group)) fail(`${label}.oracle.group must be an integer`);
  }
  if (oracle.kind === "contains") requireString(oracle.needle, `${label}.oracle.needle`);
  return oracle;
}

export function validateCampaignManifest(manifest) {
  if (manifest?.format !== "ga-evaluation-campaign-manifest/1") fail("unexpected campaign manifest format");
  requireString(manifest.version, "campaign manifest version");
  for (const field of ["promptManifest", "labelManifest", "datasetManifest"]) requireString(manifest[field], `campaign ${field}`);
  if (manifest.blindProtocol !== PROTOCOL_VERSION) fail(`campaign manifest must target ${PROTOCOL_VERSION}`);
  if (manifest.evidencePolicy?.sourceClass !== "external-public-static") fail("campaign source evidence must be external-public-static");
  if (manifest.evidencePolicy?.executionClass !== "local-runner") fail("campaign execution evidence must be local-runner");
  if (manifest.evidencePolicy?.syntheticDataAllowed !== false) fail("campaign manifest must reject synthetic data");
  if (manifest.evidencePolicy?.independentEvidence !== false) fail("local campaign cannot claim independent evidence");
  if (detectSyntheticMarkers(manifest).length > 0) fail("campaign manifest contains a synthetic or fixture marker");
  return manifest;
}

export function validatePromptManifest(manifest, datasets) {
  if (manifest?.format !== "ga-evaluation-prompt-manifest/1") fail("unexpected prompt manifest format");
  requireString(manifest.version, "prompt manifest version");
  if (manifest.blindProtocol !== PROTOCOL_VERSION) fail(`prompt manifest must target ${PROTOCOL_VERSION}`);
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length < 1) fail("prompt manifest must contain tasks");
  assertNoFixtureFields(manifest, "prompts");
  if (detectSyntheticMarkers(manifest).length > 0) fail("prompt manifest contains a synthetic or fixture marker");
  const ids = new Set();
  const sourceIds = new Set(datasets.datasets.map((dataset) => dataset.sourceId));
  const splitCounts = { visible: 0, hidden: 0, holdout: 0 };
  for (const [index, task] of manifest.tasks.entries()) {
    const label = `task[${index}]`;
    const id = requireString(task.id, `${label}.id`);
    if (ids.has(id)) fail(`duplicate task id: ${id}`);
    ids.add(id);
    if (!Object.hasOwn(manifest.splits ?? {}, task.split)) fail(`${label}.split is not declared`);
    splitCounts[task.split] += 1;
    requireString(task.sourceId, `${label}.sourceId`);
    if (!sourceIds.has(task.sourceId)) fail(`${label}.sourceId has no dataset`);
    requireString(task.prompt, `${label}.prompt`);
    for (const forbidden of ["answer", "expected", "gold", "goldAnswer", "snapshot", "oracle"]) if (Object.hasOwn(task, forbidden)) fail(`${label} leaks answer-key field ${forbidden}`);
  }
  for (const [split, definition] of Object.entries(manifest.splits)) {
    if (splitCounts[split] < definition.minimumTasks) fail(`${split} split has ${splitCounts[split]} tasks; expected at least ${definition.minimumTasks}`);
  }
  return { ...manifest, taskIds: ids, splitCounts };
}

export function validateTaskManifest(manifest, datasets) {
  return validatePromptManifest(manifest, datasets);
}

export function validateLabelManifest(manifest, prompts, datasets) {
  if (manifest?.format !== "ga-evaluation-label-manifest/1") fail("unexpected label manifest format");
  requireString(manifest.version, "label manifest version");
  if (manifest.blindProtocol !== PROTOCOL_VERSION) fail(`label manifest must target ${PROTOCOL_VERSION}`);
  if (!Array.isArray(manifest.labels) || manifest.labels.length !== prompts.tasks.length) fail("label manifest must contain exactly one label per prompt");
  assertNoFixtureFields(manifest, "labels");
  if (detectSyntheticMarkers(manifest).length > 0) fail("label manifest contains a synthetic or fixture marker");
  const datasetById = new Map(datasets.datasets.map((dataset) => [dataset.id, dataset]));
  const promptById = new Map(prompts.tasks.map((task) => [task.id, task]));
  const labels = new Map();
  for (const [index, label] of manifest.labels.entries()) {
    const labelName = `label[${index}]`;
    const id = requireString(label.id, `${labelName}.id`);
    if (labels.has(id)) fail(`duplicate label id: ${id}`);
    const prompt = promptById.get(id);
    if (!prompt) fail(`${labelName}.id does not match a prompt`);
    requireString(label.snapshot, `${labelName}.snapshot`);
    const dataset = datasetById.get(label.snapshot);
    if (!dataset || dataset.sourceId !== prompt.sourceId) fail(`${labelName}.snapshot does not match the prompt source`);
    validateOracle(label.oracle, labelName);
    labels.set(id, Object.freeze({ id, snapshot: label.snapshot, oracle: label.oracle }));
  }
  return { ...manifest, labels, labelIds: new Set(labels.keys()) };
}

export async function loadManifests() {
  const [campaignText, datasetText, promptText, labelText] = await Promise.all([
    readFile(CAMPAIGN_MANIFEST_URL, "utf8"),
    readFile(DATASET_MANIFEST_URL, "utf8"),
    readFile(PROMPT_MANIFEST_URL, "utf8"),
    readFile(LABEL_MANIFEST_URL, "utf8")
  ]);
  const campaign = validateCampaignManifest(JSON.parse(campaignText));
  const datasets = validateDatasetManifest(JSON.parse(datasetText));
  const prompts = validatePromptManifest(JSON.parse(promptText), datasets);
  const labels = validateLabelManifest(JSON.parse(labelText), prompts, datasets);
  if (campaign.promptManifest !== "../prompts/v1.json" || campaign.labelManifest !== "../labels/v1.json" || campaign.datasetManifest !== "../datasets/v1.json") fail("campaign manifest references unexpected benchmark inputs");
  if (prompts.labelManifest !== "../labels/v1.json" || labels.taskManifest !== "../prompts/v1.json") fail("prompt and label manifests are not separated by their declared references");
  const tasks = {
    ...prompts,
    tasks: prompts.tasks.map((prompt) => ({ ...prompt, ...labels.labels.get(prompt.id) }))
  };
  return { campaign, datasets, prompts, labels, tasks };
}

async function fetchPublicBytes(entry) {
  isPublicUrl(entry.downloadUrl);
  const response = await fetch(entry.downloadUrl, { headers: PUBLIC_DOWNLOAD_HEADERS });
  if (!response.ok) fail(`dataset download failed for ${entry.id}: HTTP ${response.status}`);
  isPublicUrl(response.url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256Buffer(bytes);
  if (actual !== entry.sha256) fail(`dataset hash mismatch for ${entry.id}: expected ${entry.sha256}, got ${actual}`);
  return bytes;
}

async function gitOutput(repositoryPath, args) {
  const result = await execFile("git", ["-C", repositoryPath, ...args], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
}

export async function verifyDatasets(datasets, { runtimeRoot = join(fileURLToPath(BENCHMARK_DIR), "runtime", randomUUID()) } = {}) {
  await mkdir(runtimeRoot, { recursive: true });
  const verified = new Map();
  const filesystemRoot = join(runtimeRoot, "filesystem");
  const gitRoot = join(runtimeRoot, "git");
  await mkdir(filesystemRoot, { recursive: true });
  await mkdir(gitRoot, { recursive: true });

  // ponytail: sequential public fetches keep provenance and rate-limit behavior obvious; add bounded concurrency only after measuring this suite.
  for (const entry of datasets.datasets) {
    const downloadedBytes = await fetchPublicBytes(entry);
    const record = {
      entry,
      downloadedBytes,
      downloadedSha256: sha256Buffer(downloadedBytes),
      externalEvidence: {
        kind: "external",
        origin: "public-download",
        evidenceClass: entry.evidenceClass,
        syntheticData: entry.syntheticData,
        datasetId: entry.id,
        sourceUri: entry.sourceUri,
        downloadUrl: entry.downloadUrl,
        sha256: entry.sha256
      }
    };
    assertExternalEvidence(record.externalEvidence);
    if (entry.adapter === "filesystem") {
      const filePath = join(filesystemRoot, `${safePathPart(entry.id)}.data`);
      await writeFile(filePath, downloadedBytes, { flag: "wx" });
      record.filePath = filePath;
    }
    verified.set(entry.id, record);
  }

  const gitEntries = datasets.datasets.filter((entry) => entry.adapter === "git");
  const repositories = new Map();
  for (const entry of gitEntries) {
    if (repositories.has(entry.repositoryUrl)) continue;
    const repositoryPath = join(gitRoot, `${safePathPart(entry.repository ?? "repository")}-${sha256(entry.repositoryUrl).slice(0, 12)}`);
    await execFile("git", ["clone", "--no-checkout", "--no-tags", entry.repositoryUrl, repositoryPath], { maxBuffer: 8 * 1024 * 1024 });
    repositories.set(entry.repositoryUrl, repositoryPath);
  }
  for (const entry of gitEntries) {
    const record = verified.get(entry.id);
    const repositoryPath = repositories.get(entry.repositoryUrl);
    try {
      await gitOutput(repositoryPath, ["cat-file", "-e", `${entry.commit}^{commit}`]);
      const gitBytes = await gitOutput(repositoryPath, ["show", `${entry.commit}:${entry.path}`]);
      const gitHash = sha256Buffer(gitBytes);
      if (gitHash !== entry.sha256) fail(`Git content hash mismatch for ${entry.id}: expected ${entry.sha256}, got ${gitHash}`);
      const blob = (await gitOutput(repositoryPath, ["rev-parse", `${entry.commit}:${entry.path}`])).toString("utf8").trim();
      record.repositoryPath = repositoryPath;
      record.gitBytes = gitBytes;
      record.gitBlob = blob;
      record.versionToken = `${entry.commit}:${blob}`;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("[ga-evaluation]")) throw error;
      fail(`cannot verify Git dataset ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const record of verified.values()) {
    if (record.entry.adapter !== "git") record.versionToken = record.entry.sha256;
  }
  return { runtimeRoot, verified, repositories, verifiedDatasetCount: verified.size };
}

class GitHubAdapter {
  async read(entry) {
    const bytes = await fetchPublicBytes(entry);
    return { bytes, version: { scheme: "github.sha256", token: sha256Buffer(bytes) } };
  }

  async version(entry) {
    const bytes = await fetchPublicBytes(entry);
    return { scheme: "github.sha256", token: sha256Buffer(bytes) };
  }
}

class FilesystemAdapter {
  async read(entry, record) {
    const bytes = await readFile(record.filePath);
    const token = sha256Buffer(bytes);
    if (token !== entry.sha256) fail(`filesystem evidence hash mismatch for ${entry.id}`);
    return { bytes, version: { scheme: "filesystem.sha256", token } };
  }

  async version(entry, record) {
    const bytes = await readFile(record.filePath);
    const token = sha256Buffer(bytes);
    if (token !== entry.sha256) fail(`filesystem evidence hash mismatch for ${entry.id}`);
    return { scheme: "filesystem.sha256", token };
  }
}

class GitAdapter {
  async read(entry, record) {
    const bytes = await gitOutput(record.repositoryPath, ["show", `${entry.commit}:${entry.path}`]);
    const hash = sha256Buffer(bytes);
    if (hash !== entry.sha256) fail(`Git evidence hash mismatch for ${entry.id}`);
    return { bytes, version: { scheme: "git.commit+blob", token: record.versionToken } };
  }

  async version(entry, record) {
    const bytes = await gitOutput(record.repositoryPath, ["show", `${entry.commit}:${entry.path}`]);
    const hash = sha256Buffer(bytes);
    if (hash !== entry.sha256) fail(`Git evidence hash mismatch for ${entry.id}`);
    return { scheme: "git.commit+blob", token: record.versionToken };
  }
}

const ADAPTERS = Object.freeze({ github: new GitHubAdapter(), filesystem: new FilesystemAdapter(), git: new GitAdapter() });

function textFromBytes(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("external dataset is not valid UTF-8 text");
  }
}

export class SourceBroker {
  constructor({ datasets, preflight }) {
    this.datasets = new Map(datasets.datasets.map((entry) => [entry.id, entry]));
    this.preflight = preflight;
    this.currentTask = undefined;
    this.requests = 0;
    this.readRequests = 0;
    this.versionRequests = 0;
    this.byAdapter = { github: 0, filesystem: 0, git: 0 };
    this.operations = [];
  }

  beginTask(task) {
    this.currentTask = task;
  }

  endTask() {
    this.currentTask = undefined;
  }

  get metrics() {
    return {
      requests: this.requests,
      readRequests: this.readRequests,
      versionRequests: this.versionRequests,
      byAdapter: { ...this.byAdapter },
      operations: [...this.operations]
    };
  }

  entryFor(sourceId) {
    if (!this.currentTask || this.currentTask.sourceId !== sourceId) fail(`source request does not match the active user task: ${sourceId}`);
    const entry = this.datasets.get(this.currentTask.snapshot);
    if (!entry || entry.sourceId !== sourceId) fail(`active task has no verified snapshot for ${sourceId}`);
    return entry;
  }

  async read(sourceId) {
    const entry = this.entryFor(sourceId);
    const record = this.preflight.verified.get(entry.id);
    const adapter = ADAPTERS[entry.adapter];
    if (!record || !adapter) fail(`unverified adapter state for ${entry.id}`);
    this.recordRequest(entry, "read");
    const result = await adapter.read(entry, record);
    const evidence = this.evidenceFor(entry, result.version);
    assertExternalEvidence(evidence);
    return {
      content: textFromBytes(result.bytes),
      version: result.version,
      sourceUri: entry.sourceUri,
      adapter: entry.adapter,
      provenance: evidence
    };
  }

  async version(sourceId) {
    const entry = this.entryFor(sourceId);
    const record = this.preflight.verified.get(entry.id);
    const adapter = ADAPTERS[entry.adapter];
    if (!record || !adapter) fail(`unverified adapter state for ${entry.id}`);
    this.recordRequest(entry, "version");
    const version = await adapter.version(entry, record);
    const evidence = this.evidenceFor(entry, version);
    assertExternalEvidence(evidence);
    return { version, sourceUri: entry.sourceUri, adapter: entry.adapter, provenance: evidence };
  }

  recordRequest(entry, operation) {
    this.requests += 1;
    if (operation === "read") this.readRequests += 1;
    if (operation === "version") this.versionRequests += 1;
    this.byAdapter[entry.adapter] += 1;
    this.operations.push({ operation, adapter: entry.adapter, sourceId: entry.sourceId, datasetId: entry.id });
  }

  evidenceFor(entry, version) {
    return {
      kind: "external",
      origin: "public-download",
      evidenceClass: entry.evidenceClass,
      syntheticData: entry.syntheticData,
      datasetId: entry.id,
      sourceUri: entry.sourceUri,
      downloadUrl: entry.downloadUrl,
      sha256: entry.sha256,
      version
    };
  }
}

export function publicTask(task, datasets) {
  const dataset = datasets.datasets.find((entry) => entry.sourceId === task.sourceId);
  if (!dataset) fail(`cannot build public task for ${task.sourceId}`);
  const publicValue = {
    protocol: PROTOCOL_VERSION,
    taskId: `opaque-${sha256(task.id).slice(0, 16)}`,
    prompt: task.prompt,
    source: {
      id: `opaque-source-${sha256(task.sourceId).slice(0, 16)}`,
      uri: dataset.sourceUri,
      adapter: dataset.adapter
    },
    capabilities: ["read", "version"]
  };
  const serialized = JSON.stringify(publicValue);
  for (const forbidden of ["oracle", "snapshot", "expected", "gold", "answer"]) if (serialized.includes(`\"${forbidden}\"`)) fail(`public task leaks ${forbidden}`);
  if (serialized.includes("fixture://")) fail("public task contains fixture evidence");
  return publicValue;
}

export function answerFromOracle(task, content) {
  const oracle = task.oracle;
  switch (oracle.kind) {
    case "trimmedText": return content.trim();
    case "contains": return content.includes(oracle.needle);
    case "regexBoolean": return new RegExp(oracle.pattern, oracle.flags ?? "u").test(content);
    case "regex": {
      const match = new RegExp(oracle.pattern, oracle.flags ?? "u").exec(content);
      if (!match) fail(`oracle did not match task ${task.id}`);
      return match[oracle.group];
    }
    default: fail(`unsupported oracle kind: ${oracle.kind}`);
  }
}

function verifiedContent(task, datasets, preflight) {
  const entry = datasets.datasets.find((candidate) => candidate.id === task.snapshot);
  const record = entry && preflight.verified.get(entry.id);
  if (!entry || !record) fail(`missing verified gold content for ${task.id}`);
  assertExternalEvidence(record.externalEvidence);
  const bytes = entry.adapter === "git" ? record.gitBytes : record.downloadedBytes;
  const actual = sha256Buffer(bytes);
  if (actual !== entry.sha256) fail(`gold content is not hash-verified for ${task.id}`);
  return { content: textFromBytes(bytes), entry, version: { scheme: entry.adapter === "git" ? "git.commit+blob" : `${entry.adapter}.sha256`, token: record.versionToken } };
}

export function summarizeMetrics(strategy, traces, brokerMetrics, warmupRequests = 0) {
  const tasks = traces.length;
  const available = traces.filter((trace) => trace.available).length;
  const correct = traces.filter((trace) => trace.correct).length;
  const fresh = traces.filter((trace) => trace.available && trace.fresh).length;
  const falsePositives = traces.filter((trace) => trace.falsePositive).length;
  const errors = traces.filter((trace) => trace.error !== undefined).length;
  const latencies = traces.map((trace) => trace.latencyMs);
  const requests = brokerMetrics.requests;
  const costUsd = brokerMetrics.operations.reduce((sum, operation) => sum + (COST_MODEL.perRequestUsd[operation.adapter] ?? 0), 0) + latencies.reduce((sum, value) => sum + value * COST_MODEL.computePerMsUsd, 0);
  const bySplit = {};
  for (const split of ["visible", "hidden", "holdout"]) {
    const splitTraces = traces.filter((trace) => trace.split === split);
    if (splitTraces.length === 0) continue;
    const splitAvailable = splitTraces.filter((trace) => trace.available).length;
    bySplit[split] = {
      tasks: splitTraces.length,
      correct: splitTraces.filter((trace) => trace.correct).length,
      correctRate: round(splitTraces.filter((trace) => trace.correct).length / splitTraces.length, 6),
      freshnessRate: round(splitAvailable === 0 ? 0 : splitTraces.filter((trace) => trace.available && trace.fresh).length / splitAvailable, 6),
      falsePositiveRate: round(splitTraces.filter((trace) => trace.falsePositive).length / splitTraces.length, 6),
      availabilityRate: round(splitAvailable / splitTraces.length, 6),
      latencyMs: {
        p50: round(percentile(splitTraces.map((trace) => trace.latencyMs), 0.5)),
        p95: round(percentile(splitTraces.map((trace) => trace.latencyMs), 0.95)),
        p99: round(percentile(splitTraces.map((trace) => trace.latencyMs), 0.99))
      }
    };
  }
  return {
    strategy,
    baseline: strategy === "retrieval-no-protocol",
    protocol: strategy === "PREMiSE" ? "version-gated" : strategy === "retrieval-no-protocol" ? "none" : strategy,
    tasks,
    denominators: {
      correctRate: tasks,
      falsePositiveRate: tasks,
      freshnessRate: available,
      availabilityRate: tasks
    },
    correct,
    correctRate: round(tasks === 0 ? 0 : correct / tasks, 6),
    correctPer100: round(tasks === 0 ? 0 : correct * 100 / tasks, 3),
    freshnessCount: fresh,
    freshnessRate: round(available === 0 ? 0 : fresh / available, 6),
    freshnessPer100Available: round(available === 0 ? 0 : fresh * 100 / available, 3),
    falsePositiveCount: falsePositives,
    falsePositiveRate: round(tasks === 0 ? 0 : falsePositives / tasks, 6),
    available,
    availabilityRate: round(tasks === 0 ? 0 : available / tasks, 6),
    availabilityPer100: round(tasks === 0 ? 0 : available * 100 / tasks, 3),
    errors,
    errorRate: round(tasks === 0 ? 0 : errors / tasks, 6),
    errorsPer100: round(tasks === 0 ? 0 : errors * 100 / tasks, 3),
    requests,
    warmupRequests,
    requestsPerTask: round(tasks === 0 ? 0 : requests / tasks, 6),
    readRequests: brokerMetrics.readRequests,
    versionRequests: brokerMetrics.versionRequests,
    adapterRequests: brokerMetrics.byAdapter,
    costUsd: round(costUsd, 8),
    costPer1000TasksUsd: round(tasks === 0 ? 0 : costUsd * 1000 / tasks, 8),
    latencyMs: {
      p50: round(percentile(latencies, 0.5)),
      p95: round(percentile(latencies, 0.95)),
      p99: round(percentile(latencies, 0.99))
    },
    bySplit
  };
}

function traceFor({ strategy, task, response, error, latencyMs, gold, currentVersion, requests, operations }) {
  const available = error === undefined && response?.answer !== undefined && response?.decision === "USE";
  const correct = available && normalizeAnswer(response.answer) === normalizeAnswer(gold);
  const evidenceVersion = response?.version?.token ?? response?.lastVersion?.token;
  const fresh = available && evidenceVersion !== undefined && evidenceVersion === currentVersion.token;
  const falsePositive = available && !correct;
  return {
    strategy,
    taskId: task.id,
    split: task.split,
    sourceId: task.sourceId,
    adapter: response?.adapter ?? task.adapter,
    decision: response?.decision ?? "ERROR",
    status: response?.status ?? "UNKNOWN",
    available,
    correct,
    fresh,
    falsePositive,
    requests,
    operations,
    latencyMs: round(latencyMs),
    answerDigest: response?.answer === undefined ? undefined : answerDigest(response.answer),
    evidenceVersion: evidenceVersion === undefined ? undefined : sha256(String(evidenceVersion)),
    currentVersion: sha256(String(currentVersion.token)),
    evidenceOrigin: response?.provenance?.origin,
    ...(error === undefined ? {} : { error })
  };
}

function firstTaskBySource(tasks) {
  const first = new Map();
  for (const task of tasks) if (!first.has(task.sourceId)) first.set(task.sourceId, task);
  return [...first.values()];
}

async function runReferenceStrategy(strategy, tasks, datasets, preflight, options = {}) {
  const broker = new SourceBroker({ datasets, preflight });
  const cache = new Map();
  const traces = [];
  let warmupRequests = 0;
  if (strategy === "retrieval-no-protocol") {
    for (const task of firstTaskBySource(tasks)) {
      broker.beginTask(task);
      const before = broker.requests;
      const evidence = await broker.read(task.sourceId);
      cache.set(task.sourceId, { evidence, at: task.__order });
      warmupRequests += broker.requests - before;
      broker.endTask();
    }
  }
  for (const task of tasks) {
    broker.beginTask(task);
    const beforeRequests = broker.requests;
    const beforeOperations = broker.operations.length;
    const started = performance.now();
    let response;
    let error;
    try {
      if (strategy === "direct-read") {
        const evidence = await broker.read(task.sourceId);
        response = { answer: answerFromOracle(task, evidence.content), decision: "USE", status: "FRESH", ...evidence };
      } else if (strategy === "ttl-cache") {
        const cached = cache.get(task.sourceId);
        const ttlTurns = options.ttlTurns ?? 3;
        const usable = cached !== undefined && task.__order - cached.at < ttlTurns;
        const evidence = usable ? cached.evidence : await broker.read(task.sourceId);
        if (!usable) cache.set(task.sourceId, { evidence, at: task.__order });
        response = { answer: answerFromOracle(task, evidence.content), decision: "USE", status: usable ? "TTL-CACHED" : "FRESH", ...evidence };
      } else if (strategy === "retrieval-no-protocol") {
        const cached = cache.get(task.sourceId);
        response = { answer: answerFromOracle(task, cached.evidence.content), decision: "USE", status: "UNTRACKED", ...cached.evidence };
      } else if (strategy === "PREMiSE") {
        const cached = cache.get(task.sourceId);
        if (!cached) {
          const evidence = await broker.read(task.sourceId);
          cache.set(task.sourceId, { evidence, at: task.__order });
          response = { answer: answerFromOracle(task, evidence.content), decision: "USE", status: "FRESH", ...evidence };
        } else {
          const probe = await broker.version(task.sourceId);
          if (probe.version.token === cached.evidence.version.token) {
            response = { answer: answerFromOracle(task, cached.evidence.content), decision: "USE", status: "FRESH", ...cached.evidence, lastVersion: probe.version };
          } else {
            const evidence = await broker.read(task.sourceId);
            cache.set(task.sourceId, { evidence, at: task.__order });
            response = { answer: answerFromOracle(task, evidence.content), decision: "USE", status: "REVALIDATED", ...evidence, lastVersion: probe.version };
          }
        }
      } else {
        fail(`unknown reference strategy: ${strategy}`);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const latencyMs = performance.now() - started;
    const gold = verifiedContent(task, datasets, preflight);
    const operations = broker.operations.slice(beforeOperations).map(({ operation, adapter }) => `${operation}:${adapter}`);
    traces.push(traceFor({
      strategy,
      task,
      response,
      error,
      latencyMs,
      gold: answerFromOracle(task, gold.content),
      currentVersion: gold.version,
      requests: broker.requests - beforeRequests,
      operations
    }));
    broker.endTask();
  }
  return { strategy, traces, metrics: summarizeMetrics(strategy, traces, broker.metrics, warmupRequests), brokerMetrics: broker.metrics };
}

function candidateProcess(command, cwd) {
  return spawn(command, {
    shell: true,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec,
      GA_EVALUATION_PROTOCOL: PROTOCOL_VERSION
    }
  });
}

function nextLine(iterator, timeoutMs = 120000) {
  let timer;
  return Promise.race([
    iterator.next().then((result) => result.done ? fail("candidate closed stdout before answering") : result.value),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`candidate protocol timeout after ${timeoutMs}ms`)), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

function writeLine(stream, value) {
  if (!stream.write(`${JSON.stringify(value)}\n`)) return new Promise((resolve) => stream.once("drain", resolve));
  return undefined;
}

async function runCandidate(command, tasks, datasets, preflight, options = {}) {
  const broker = new SourceBroker({ datasets, preflight });
  const child = candidateProcess(command, preflight.runtimeRoot);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const traces = [];
  let fatal;
  const taskTimeoutMs = options.taskTimeoutMs ?? 120000;
  for (const task of tasks) {
    broker.beginTask(task);
    const beforeRequests = broker.requests;
    const beforeOperations = broker.operations.length;
    const started = performance.now();
    let response;
    let lastEvidence;
    let error;
    try {
      const taskForCandidate = publicTask(task, datasets);
      await writeLine(child.stdin, { type: "task", task: taskForCandidate });
      while (true) {
        const raw = await nextLine(iterator, taskTimeoutMs);
        let message;
        try { message = JSON.parse(raw); } catch { fail("candidate emitted non-JSON stdout"); }
        if (!message || typeof message.type !== "string") fail("candidate message must contain type");
        if (message.type === "read" || message.type === "version") {
          if (message.sourceId !== taskForCandidate.source.id) fail("candidate requested a source outside the active task");
          if (message.type === "read") {
            const evidence = await broker.read(task.sourceId);
            lastEvidence = evidence;
            await writeLine(child.stdin, { type: "evidence", requestId: message.requestId ?? null, sourceId: taskForCandidate.source.id, content: evidence.content, version: evidence.version, sourceUri: evidence.sourceUri, adapter: evidence.adapter, provenance: evidence.provenance });
          } else {
            const evidence = await broker.version(task.sourceId);
            lastEvidence = evidence;
            await writeLine(child.stdin, { type: "version", requestId: message.requestId ?? null, sourceId: taskForCandidate.source.id, version: evidence.version, sourceUri: evidence.sourceUri, adapter: evidence.adapter, provenance: evidence.provenance });
          }
          continue;
        }
        if (message.type === "answer") {
          if (!Object.hasOwn(message, "answer")) fail("candidate answer message must contain answer");
          const decision = message.decision ?? "USE";
          if (!["USE", "REJECT", "REVALIDATE"].includes(decision)) fail(`unsupported candidate decision: ${decision}`);
          response = { answer: message.answer, decision, status: message.status ?? "UNKNOWN", adapter: lastEvidence?.adapter, provenance: lastEvidence?.provenance, version: lastEvidence?.version };
          break;
        }
        if (message.type === "log") continue;
        fail(`unsupported candidate message type: ${message.type}`);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      fatal = error;
    }
    const latencyMs = performance.now() - started;
    const gold = verifiedContent(task, datasets, preflight);
    const operations = broker.operations.slice(beforeOperations).map(({ operation, adapter }) => `${operation}:${adapter}`);
    traces.push(traceFor({
      strategy: "candidate",
      task,
      response,
      error,
      latencyMs,
      gold: answerFromOracle(task, gold.content),
      currentVersion: gold.version,
      requests: broker.requests - beforeRequests,
      operations
    }));
    broker.endTask();
    if (fatal) break;
  }
  if (fatal) {
    for (const task of tasks.slice(traces.length)) {
      traces.push({ strategy: "candidate", taskId: task.id, split: task.split, sourceId: task.sourceId, adapter: "unknown", decision: "ERROR", status: "UNKNOWN", available: false, correct: false, fresh: false, falsePositive: false, requests: 0, operations: [], latencyMs: 0, error: `candidate aborted: ${fatal}` });
    }
    child.kill();
  } else {
    await writeLine(child.stdin, { type: "end" });
    child.stdin.end();
  }
  lines.close();
  return { strategy: "candidate", traces, metrics: summarizeMetrics("candidate", traces, broker.metrics), brokerMetrics: broker.metrics };
}

export async function runStrategy(strategy, tasks, datasets, preflight, options = {}) {
  if (strategy === "candidate") return runCandidate(options.candidateCommand, tasks, datasets, preflight, options);
  return runReferenceStrategy(strategy, tasks, datasets, preflight, options);
}

export function expandTasks(taskManifest, split, repetitions = 1) {
  const selected = split === "all" ? taskManifest.tasks : taskManifest.tasks.filter((task) => task.split === split);
  if (selected.length === 0) fail(`no tasks selected for split ${split}`);
  const tasks = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    for (const task of selected) tasks.push({ ...task, id: repetitions === 1 ? task.id : `${task.id}#${repetition + 1}`, __order: tasks.length });
  }
  return tasks;
}

export function renderMarkdown(result) {
  const rows = result.metrics.map((metric) => `| ${metric.strategy}${metric.baseline ? " (baseline without protocol)" : ""} | ${metric.tasks} | ${(metric.correctRate * 100).toFixed(2)}% | ${(metric.freshnessRate * 100).toFixed(2)}% | ${(metric.falsePositiveRate * 100).toFixed(2)}% | ${(metric.availabilityRate * 100).toFixed(2)}% | ${(metric.errorRate * 100).toFixed(2)}% | ${metric.latencyMs.p50} / ${metric.latencyMs.p95} / ${metric.latencyMs.p99} | ${metric.requests} | $${metric.costPer1000TasksUsd.toFixed(8)} |`).join("\n");
  const splitRows = result.metrics.flatMap((metric) => Object.entries(metric.bySplit).map(([split, value]) => `| ${metric.strategy} | ${split} | ${value.tasks} | ${(value.correctRate * 100).toFixed(2)}% | ${(value.freshnessRate * 100).toFixed(2)}% | ${(value.falsePositiveRate * 100).toFixed(2)}% | ${(value.availabilityRate * 100).toFixed(2)}% | ${value.latencyMs.p50} / ${value.latencyMs.p95} / ${value.latencyMs.p99} |`)).join("\n");
  return `# GA Evaluation ${result.benchmark.manifestVersion}\n\n` +
    `Run: \`${result.benchmark.runId}\`  \n` +
    `Generated: \`${result.benchmark.generatedAt}\`  \n` +
    `Split: \`${result.benchmark.split}\`  \n` +
    `Tasks: **${result.benchmark.tasks}**  \n` +
    `Blind protocol: \`${result.benchmark.blindProtocol}\`  \n\n` +
    `## Verification\n\n` +
    `- Source evidence: **${result.evidence.source.class}**; pinned and hash-verified: **${result.evidence.source.hashesVerified}**\n` +
    `- Execution evidence: **${result.evidence.execution.class}**; independent: **${result.evidence.execution.independent}**\n` +
    `- Synthetic data accepted: **${result.evidence.syntheticData.accepted}**; detected markers: **${result.evidence.syntheticData.detectedMarkers}**\n` +
    `- Datasets verified: **${result.verification.datasetsVerified}**\n` +
    `- Hash algorithm: **${result.verification.hashAlgorithm}**\n` +
    `- External source evidence only: **${result.verification.externalOnly}**\n` +
    `- Fixture evidence accepted: **${result.verification.fixtureEvidenceAccepted}**\n` +
    `- Dataset verification requests: **${result.verification.datasetVerificationRequests}**\n\n` +
    `## Aggregate metrics\n\n` +
    `Accuracy uses all selected tasks; freshness uses available answers; availability is a usable USE answer; latency is p50 / p95 / p99 in milliseconds including errors.\n\n` +
    `| Strategy | Tasks | Accuracy | Freshness | False positives | Availability | Error rate | Latency p50 / p95 / p99 ms | Requests | Cost proxy / 1,000 tasks |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n` +
    `## Split metrics\n\n` +
    `| Strategy | Split | Tasks | Correct | Freshness | False positives | Availability | Latency p50 / p95 / p99 ms |\n|---|---|---:|---:|---:|---:|---:|---:|\n${splitRows}\n\n` +
    `## Allowed claims\n\n` +
    `- This run supports only the reported exact-answer, source-freshness, false-positive, availability, request, latency, and source-operation cost observations for this manifest, dataset hashes, runner version, and local execution environment.\n` +
    `- A PREMiSE result here means the version-gated reference behavior named **PREMiSE**; it is not a claim about every implementation or deployment.\n` +
    `- Public-source evidence was fetched and hash-checked before evaluation; the metrics and runner execution remain local evidence.\n\n` +
    `## Claims not allowed\n\n` +
    `- No universal truth, model intelligence, semantic retrieval quality, production SLA, provider invoice, security guarantee, or causal product uplift may be inferred from this run.\n` +
    `- Static public snapshots do not prove recovery from a live mutation. The changed-snapshot tasks measure a reproducible version transition, not a live repository mutation campaign.\n` +
    `- Holdout numbers must not be tuned on and must not be reported as independent without an external holdout attestation.\n`;
}

export function buildResult({ runId, generatedAt, split, repetitions, tasks, datasets, taskManifest, labelManifest, preflight, strategies, candidateCommand }) {
  const allTraces = strategies.flatMap((strategy) => strategy.traces);
  const verification = {
    datasetsVerified: preflight.verifiedDatasetCount,
    hashAlgorithm: "sha256",
    externalOnly: true,
    fixtureEvidenceAccepted: false,
    datasetVerificationRequests: preflight.verifiedDatasetCount,
    verifiedDatasetIds: [...preflight.verified.keys()].sort()
  };
  for (const trace of allTraces) {
    if (trace.evidenceOrigin !== undefined && trace.evidenceOrigin !== "public-download") fail(`trace ${trace.taskId} contains non-public evidence`);
    if (Object.hasOwn(trace, "answer") || Object.hasOwn(trace, "expected") || Object.hasOwn(trace, "oracle") || Object.hasOwn(trace, "snapshot")) fail("trace leaks an answer key field");
  }
  return {
    format: RESULT_FORMAT,
    runner: RUNNER_VERSION,
    benchmark: {
      runId,
      generatedAt,
      manifestVersion: taskManifest.version,
      promptManifestVersion: taskManifest.version,
      labelManifestVersion: labelManifest?.version ?? taskManifest.version,
      datasetManifestVersion: datasets.version,
      blindProtocol: PROTOCOL_VERSION,
      blind: true,
      split,
      repetitions,
      tasks: tasks.length,
      candidate: candidateCommand ? "external-candidate" : "reference-strategies",
      baselineStrategy: "retrieval-no-protocol"
    },
    evidence: {
      source: { class: "external-public-static", hashesVerified: true, live: false, syntheticData: false },
      execution: { class: "local-runner", independent: false, liveConnector: false },
      syntheticData: { accepted: false, detectedMarkers: 0, method: "manifest-reference-denylist-and-pinned-public-commit" },
      eligibleForPublicClaim: false
    },
    verification,
    costModel: COST_MODEL,
    metrics: strategies.map((strategy) => strategy.metrics),
    traceCount: allTraces.length,
    claims: {
      allowed: ["exact answer rate for this task manifest", "source-version freshness", "false-positive rate as wrong USE answers", "task availability", "source-operation request count", "local latency percentiles", "source-operation cost proxy"],
      forbidden: ["universal truth", "model quality outside this task parser", "production SLA", "provider invoice", "causal product uplift", "live mutation recovery from static snapshots", "independent external evidence"]
    }
  };
}

export async function writeOutputs(result, strategies, outputDir = new URL("../outputs/", import.meta.url)) {
  await mkdir(outputDir, { recursive: true });
  const report = renderMarkdown(result);
  const traces = strategies.flatMap((strategy) => strategy.traces).map((trace) => JSON.stringify(trace)).join("\n") + "\n";
  await writeFile(new URL("./results.json", outputDir), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(new URL("./report.md", outputDir), report, "utf8");
  await writeFile(new URL("./traces.jsonl", outputDir), traces, "utf8");
  return { report, traces };
}

export function outputPaths(outputDir = new URL("../outputs/", import.meta.url)) {
  return {
    result: new URL("./results.json", outputDir),
    report: new URL("./report.md", outputDir),
    traces: new URL("./traces.jsonl", outputDir)
  };
}

export { assertNoFixtureFields, fetchPublicBytes, isFixtureReference, isPublicUrl, verifiedContent };
