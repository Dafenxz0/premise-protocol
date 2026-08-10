#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SCRIPT_VERSION = "1.0.0";
const CONFIRMATION = "I_UNDERSTAND_ROLLBACK";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

class SmokeError extends Error {
  constructor(code, message, details = undefined, exitCode = 1) {
    super(message);
    this.name = "RollbackSmokeError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

function usage() {
  return `PREMiSE Compose rollback smoke ${SCRIPT_VERSION}

Usage:
  node deploy/rollback-smoke.mjs --confirm I_UNDERSTAND_ROLLBACK
    --current-image <image-ref> --previous-image <image-ref>

Required inputs may also be supplied through:
  PREMISE_ROLLBACK_CONFIRM
  PREMISE_ROLLBACK_CURRENT_IMAGE
  PREMISE_ROLLBACK_PREVIOUS_IMAGE

Optional inputs:
  COMPOSE_FILE                       Compose file (default: deploy/docker-compose.yml)
  COMPOSE_PROJECT_NAME               Compose project to exercise
  BASE_URL                           Host URL (default: http://127.0.0.1:3000)
  PREMISE_TENANT_ID                  Tenant used for the verification record
  PREMISE_API_TOKEN                  Bearer token, when the stack is protected
  ROLLBACK_SMOKE_RESULT_FILE         JSON artifact (default: .ga-artifacts/rollback-smoke.json)
  ROLLBACK_SMOKE_TIMEOUT_MS          Readiness timeout (default: 120000)
  ROLLBACK_SMOKE_POLL_MS             Readiness poll interval (default: 2000)
  ROLLBACK_SMOKE_REQUEST_TIMEOUT_MS  HTTP probe timeout (default: 5000)
  ROLLBACK_SMOKE_COMPOSE_TIMEOUT_MS  Compose command timeout (default: 180000)
  ROLLBACK_SMOKE_PULL=1              Pull both refs before inspecting them
  ROLLBACK_SMOKE_REQUIRE_CLEAN=1     Reject a dirty Git worktree

Safety:
  The runner never executes 'down -v', removes containers, or deletes volumes.
  It leaves the Compose service running on the previous image after a pass.
`;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") {
      result.help = true;
      continue;
    }
    if (value === "--confirm" || value === "--current-image" || value === "--previous-image" || value === "--compose-file" || value === "--base-url" || value === "--result") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new SmokeError("INVALID_ARGUMENT", `${value} requires a value`, undefined, 2);
      const key = value.slice(2).replaceAll("-", "");
      result[key] = next;
      index += 1;
      continue;
    }
    throw new SmokeError("INVALID_ARGUMENT", `Unknown argument: ${value}`, undefined, 2);
  }
  return result;
}

function integerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SmokeError("INVALID_CONFIGURATION", `${name} must be an integer from ${minimum} to ${maximum}`, { value: raw }, 2);
  }
  return value;
}

function nonEmpty(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new SmokeError("MISSING_CONFIGURATION", `${name} is required`, undefined, 2);
  return value.trim();
}

function resolvePath(value, fallback) {
  return resolve(repositoryRoot, value ?? fallback);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonStable(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonStable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonStable(value[key])]));
  }
  return value;
}

function digestJson(value) {
  return sha256(JSON.stringify(canonicalJsonStable(value)));
}

function now() {
  return new Date().toISOString();
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function redact(value) {
  return String(value)
    .replace(/(postgres(?:ql)?):\/\/[^\s"']+/giu, "$1://[REDACTED]")
    .replace(/(Bearer\s+)[\x21-\x7e]+/giu, "$1[REDACTED]")
    .replace(/(password|token|secret|authorization)(\s*[:=]\s*)[^\s,;]+/giu, "$1$2[REDACTED]");
}

function tail(value, limit = 2000) {
  const safe = redact(value ?? "");
  return safe.length <= limit ? safe : safe.slice(-limit);
}

function commandRecord(command, args, result, startedAt, completedAt) {
  return {
    command,
    args,
    startedAt,
    completedAt,
    exitCode: result.exitCode,
    signal: result.signal ?? null,
    timedOut: result.timedOut === true,
    ...(result.exitCode === 0 ? {} : { stderrTail: tail(result.stderr), stdoutTail: tail(result.stdout) })
  };
}

function runCommand(command, args, options = {}) {
  const startedAt = now();
  const timeoutMs = options.timeoutMs ?? 180_000;
  const environment = { ...process.env, ...(options.env ?? {}) };
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const append = (target, chunk) => {
      const text = chunk.toString();
      return (target + text).slice(-100_000);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const finish = (exitCode, signal = null, error = undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode, signal, stdout, stderr, timedOut, error });
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (exitCode, signal) => finish(exitCode, signal));
  }).then((result) => {
    const completedAt = now();
    if (options.auditCommands) options.auditCommands.push(commandRecord(command, args, result, startedAt, completedAt));
    return result;
  });
}

async function requiredCommand(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  if (result.error !== undefined) throw new SmokeError("COMMAND_UNAVAILABLE", `Could not execute ${command}`, { message: result.error.message }, 2);
  if (result.timedOut) throw new SmokeError("COMMAND_TIMEOUT", `${command} timed out`, { timeoutMs: options.timeoutMs }, 1);
  if (result.exitCode !== 0) throw new SmokeError("COMMAND_FAILED", `${command} exited with ${result.exitCode}`, { stderr: tail(result.stderr), stdout: tail(result.stdout) }, 1);
  return result;
}

function phase(audit, name, operation) {
  const item = { name, status: "running", startedAt: now() };
  audit.phases.push(item);
  return Promise.resolve()
    .then(operation)
    .then((result) => {
      item.status = "passed";
      item.completedAt = now();
      if (result !== undefined) item.result = result;
      return result;
    })
    .catch((error) => {
      item.status = "failed";
      item.completedAt = now();
      item.error = error instanceof SmokeError ? { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } : { code: "UNEXPECTED_ERROR", message: error instanceof Error ? error.message : String(error) };
      throw error;
    });
}

function assertCondition(audit, id, condition, details) {
  const assertion = { id, passed: condition, ...(details === undefined ? {} : { details }) };
  audit.assertions.push(assertion);
  if (!condition) throw new SmokeError("ASSERTION_FAILED", `Rollback assertion failed: ${id}`, details, 1);
}

function dockerArgs(composeFile, projectName, args) {
  const prefix = ["compose", "-f", composeFile];
  if (projectName !== undefined) prefix.push("--project-name", projectName);
  return [...prefix, ...args];
}

function composeEnvironment(image, projectName) {
  return {
    ...(image === undefined ? {} : { PREMISE_IMAGE: image }),
    ...(projectName === undefined ? {} : { COMPOSE_PROJECT_NAME: projectName })
  };
}

async function dockerCompose(config, args, image, audit, options = {}) {
  return requiredCommand("docker", dockerArgs(config.composeFile, config.projectName, args), {
    timeoutMs: options.timeoutMs ?? config.composeTimeoutMs,
    env: composeEnvironment(image, config.projectName),
    auditCommands: audit.commands
  });
}

async function inspectImage(config, image, audit) {
  const result = await requiredCommand("docker", ["image", "inspect", image], { auditCommands: audit.commands, timeoutMs: config.composeTimeoutMs });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new SmokeError("INVALID_IMAGE_INSPECTION", `Docker returned invalid metadata for ${image}`, { message: error.message }, 2);
  }
  const item = parsed?.[0];
  if (!item || typeof item.Id !== "string" || item.Id.length === 0) throw new SmokeError("IMAGE_NOT_IDENTIFIABLE", `Image ${image} has no stable local ID`, undefined, 2);
  const labels = item.Config?.Labels ?? {};
  const selectedLabels = Object.fromEntries(["org.opencontainers.image.revision", "org.opencontainers.image.version", "org.opencontainers.image.created", "org.opencontainers.image.source"].filter((key) => typeof labels[key] === "string").map((key) => [key, labels[key]]));
  return {
    reference: image,
    id: item.Id,
    created: item.Created ?? null,
    repoTags: Array.isArray(item.RepoTags) ? item.RepoTags : [],
    repoDigests: Array.isArray(item.RepoDigests) ? item.RepoDigests : [],
    labels: selectedLabels
  };
}

async function inspectContainer(config, audit, image) {
  const ps = await dockerCompose(config, ["ps", "-q", config.service], image, audit);
  const containerIds = ps.stdout.trim().split(/\s+/u).filter(Boolean);
  if (containerIds.length === 0) return undefined;
  if (containerIds.length !== 1) throw new SmokeError("MULTIPLE_CONTAINERS", `Rollback smoke requires exactly one ${config.service} container`, { count: containerIds.length }, 2);
  const containerId = containerIds[0];
  const inspected = await requiredCommand("docker", ["inspect", containerId], { auditCommands: audit.commands, timeoutMs: config.composeTimeoutMs });
  let parsed;
  try {
    parsed = JSON.parse(inspected.stdout);
  } catch (error) {
    throw new SmokeError("INVALID_CONTAINER_INSPECTION", "Docker returned invalid container metadata", { message: error.message }, 1);
  }
  const item = parsed?.[0];
  if (!item) return undefined;
  return {
    id: item.Id ?? containerId,
    imageId: item.Image ?? null,
    configuredImage: item.Config?.Image ?? null,
    status: item.State?.Status ?? null,
    running: item.State?.Running === true,
    health: item.State?.Health?.Status ?? null,
    restartCount: Number.isSafeInteger(item.RestartCount) ? item.RestartCount : null,
    startedAt: item.State?.StartedAt ?? null,
    labels: Object.fromEntries(["com.docker.compose.project", "com.docker.compose.service", "org.opencontainers.image.revision", "org.opencontainers.image.version"].filter((key) => typeof item.Config?.Labels?.[key] === "string").map((key) => [key, item.Config.Labels[key]]))
  };
}

async function httpJson(config, path, init = {}) {
  const headers = { "content-type": "application/json", ...(config.apiToken === undefined ? {} : { authorization: `Bearer ${config.apiToken}` }), ...(init.headers ?? {}) };
  let response;
  try {
    response = await fetch(new URL(path, config.baseUrl), { ...init, headers, signal: AbortSignal.timeout(config.requestTimeoutMs) });
  } catch (error) {
    throw new SmokeError("HTTP_UNAVAILABLE", `HTTP request to ${path} failed`, { message: error instanceof Error ? error.message : String(error) }, 1);
  }
  const text = await response.text();
  let body;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: response.status, ok: response.ok, body };
}

async function readiness(config, audit, expectedImage, label) {
  const startedAt = now();
  const deadline = Date.now() + config.timeoutMs;
  const attempts = [];
  let lastContainer;
  let lastHttp;
  let lastHealthcheck;
  while (Date.now() <= deadline) {
    lastContainer = await inspectContainer(config, audit, expectedImage.reference).catch((error) => {
      if (error instanceof SmokeError && ["COMMAND_FAILED", "HTTP_UNAVAILABLE"].includes(error.code)) return undefined;
      throw error;
    });
    try {
      lastHttp = await httpJson(config, "/readyz");
    } catch (error) {
      if (!(error instanceof SmokeError && error.code === "HTTP_UNAVAILABLE")) throw error;
      lastHttp = { status: null, ok: false, body: { ok: false, error: error.message } };
    }
    const imageMatches = lastContainer?.imageId === expectedImage.id;
    const containerReady = lastContainer?.running === true && lastContainer.health === "healthy";
    const databaseReady = lastHttp.body?.checks?.database === "ok";
    const httpReady = lastHttp.status === 200 && lastHttp.ok && lastHttp.body?.ok === true && lastHttp.body?.ready === true && databaseReady;
    const attempt = { at: now(), containerId: lastContainer?.id ?? null, imageId: lastContainer?.imageId ?? null, containerHealth: lastContainer?.health ?? null, httpStatus: lastHttp.status, httpReady, databaseReady, imageMatches };
    attempts.push(attempt);
    if (containerReady && httpReady && imageMatches) {
      const healthcheck = await dockerCompose(config, ["exec", "-T", "-e", "PREMISE_HEALTH_PATH=/readyz", config.service, "node", "/app/ops/healthcheck.mjs"], expectedImage.reference, audit).catch((error) => {
        if (error instanceof SmokeError) return { ok: false, error: { code: error.code, message: error.message } };
        throw error;
      });
      lastHealthcheck = healthcheck.ok === false ? healthcheck : { ok: true, exitCode: healthcheck.exitCode };
      if (lastHealthcheck.ok === true) {
        const health = await httpJson(config, "/health");
        return {
          label,
          startedAt,
          completedAt: now(),
          attempts,
          container: lastContainer,
          readiness: lastHttp.body,
          health: health.body,
          healthcheck: lastHealthcheck
        };
      }
    }
    await sleep(Math.min(config.pollMs, Math.max(0, deadline - Date.now())));
  }
  throw new SmokeError("READINESS_TIMEOUT", `${label} did not become ready within ${config.timeoutMs} ms`, { attempts, lastContainer: lastContainer ?? null, lastHttp: lastHttp ?? null, lastHealthcheck: lastHealthcheck ?? null }, 1);
}

function verificationRecord(config, runId) {
  const at = now();
  const memoryId = `memory:rollback-smoke:${runId}`;
  const sourceUri = `rollback-smoke://${runId}`;
  const marker = `PREMiSE_ROLLBACK_SMOKE_${runId}`;
  return {
    memoryId,
    marker,
    record: {
      envelope: {
        specVersion: "premise/2",
        tenantId: config.tenantId,
        memoryId,
        evidence: [{ evidenceId: `evidence:${memoryId}`, sourceUri, observedAt: at, version: { scheme: "rollback-smoke", token: runId }, validator: { id: "rollback-smoke", operation: "read" } }],
        confidence: { score: null, method: "rollback-smoke", assessedAt: at },
        conflicts: [],
        temporal: { asOf: at },
        validity: { status: "FRESH", checkedAt: at, policy: "MANUAL" },
        dependsOn: [],
        signatures: []
      },
      content: marker
    }
  };
}

async function writeAndReadRecord(config, audit, verification) {
  const stored = await httpJson(config, "/v2/memories", { method: "POST", body: JSON.stringify({ record: verification.record }) });
  assertCondition(audit, "current-write-accepted", stored.status === 201 && stored.body?.memoryId === verification.memoryId, { status: stored.status, body: stored.body });
  const fetched = await httpJson(config, `/v2/memories/${encodeURIComponent(verification.memoryId)}`);
  assertCondition(audit, "current-read-roundtrip", fetched.status === 200 && fetched.body?.content === verification.marker && fetched.body?.envelope?.memoryId === verification.memoryId, { status: fetched.status, recordSha256: fetched.status === 200 ? digestJson(fetched.body) : null });
  return { status: fetched.status, recordSha256: digestJson(fetched.body), record: fetched.body };
}

async function verifyAfterRollback(config, audit, verification, baseline) {
  const fetched = await httpJson(config, `/v2/memories/${encodeURIComponent(verification.memoryId)}`);
  const afterDigest = fetched.status === 200 ? digestJson(fetched.body) : null;
  assertCondition(audit, "rollback-read-roundtrip", fetched.status === 200 && fetched.body?.content === verification.marker && fetched.body?.envelope?.memoryId === verification.memoryId, { status: fetched.status, recordSha256: afterDigest });
  assertCondition(audit, "rollback-data-unchanged", afterDigest === baseline.recordSha256, { beforeSha256: baseline.recordSha256, afterSha256: afterDigest });
  const capabilities = await httpJson(config, "/v2/capabilities");
  assertCondition(audit, "rollback-api-contract", capabilities.status === 200 && capabilities.body?.specVersion === "premise/2", { status: capabilities.status, specVersion: capabilities.body?.specVersion ?? null });
  return { status: fetched.status, recordSha256: afterDigest, capabilities: capabilities.body };
}

function imageReferenceIsSafeForAudit(reference) {
  if (reference.includes("@sha256:")) return true;
  const tag = reference.includes(":") && reference.lastIndexOf(":") > reference.lastIndexOf("/") ? reference.slice(reference.lastIndexOf(":") + 1).toLowerCase() : "";
  if (tag.length === 0) return false;
  if (process.env.ROLLBACK_SMOKE_ALLOW_MUTABLE_TAGS === "1") return true;
  return !new Set(["latest", "stable", "current", "previous", "local"]).has(tag);
}

async function gitEvidence(audit) {
  const commitResult = await requiredCommand("git", ["rev-parse", "HEAD"], { auditCommands: audit.commands, timeoutMs: 10_000 });
  const statusResult = await requiredCommand("git", ["status", "--porcelain=v1"], { auditCommands: audit.commands, timeoutMs: 10_000 });
  const dirtyFiles = statusResult.stdout.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(0, 2));
  if (process.env.ROLLBACK_SMOKE_REQUIRE_CLEAN === "1" && dirtyFiles.length > 0) throw new SmokeError("DIRTY_WORKTREE", "A clean worktree is required for this rollback evidence", { changedEntries: dirtyFiles.length }, 2);
  return { commit: commitResult.stdout.trim(), dirty: dirtyFiles.length > 0, changedEntries: dirtyFiles.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const startedAt = now();
  const runId = randomUUID();
  const composeFile = resolvePath(args.composefile ?? process.env.COMPOSE_FILE, "deploy/docker-compose.yml");
  const resultFile = resolvePath(args.result ?? process.env.ROLLBACK_SMOKE_RESULT_FILE, ".ga-artifacts/rollback-smoke.json");
  const audit = {
    schema: "premise/rollback-smoke",
    schemaVersion: 1,
    runnerVersion: SCRIPT_VERSION,
    runId,
    generatedAt: startedAt,
    commit: null,
    source: { kind: "docker-compose", composeFile: relative(repositoryRoot, composeFile) },
    trace: { runId, commandCount: 0, phaseCount: 0 },
    status: "running",
    ok: false,
    startedAt,
    completedAt: null,
    artifact: { path: resultFile, repositoryRelativePath: relative(repositoryRoot, resultFile) },
    repository: null,
    inputs: null,
    phases: [],
    assertions: [],
    commands: [],
    evidence: { imageReferences: {}, deployments: {}, data: {} },
    failure: null
  };

  let exitCode = 1;
  try {
    const composeText = await readFile(composeFile, "utf8").catch((error) => {
      throw new SmokeError("COMPOSE_FILE_MISSING", `Compose file is not readable: ${composeFile}`, { message: error.message }, 2);
    });
    const runnerText = await readFile(fileURLToPath(import.meta.url), "utf8");
    const currentImage = nonEmpty(args.currentimage ?? process.env.PREMISE_ROLLBACK_CURRENT_IMAGE, "PREMISE_ROLLBACK_CURRENT_IMAGE");
    const previousImage = nonEmpty(args.previousimage ?? process.env.PREMISE_ROLLBACK_PREVIOUS_IMAGE, "PREMISE_ROLLBACK_PREVIOUS_IMAGE");
    const baseUrl = nonEmpty(args.baseurl ?? process.env.BASE_URL ?? "http://127.0.0.1:3000", "BASE_URL");
    try {
      const parsedBaseUrl = new URL(baseUrl);
      if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) throw new Error("BASE_URL must use http or https");
      if (parsedBaseUrl.username.length > 0 || parsedBaseUrl.password.length > 0) throw new Error("BASE_URL must not contain credentials");
    } catch (error) {
      throw new SmokeError("INVALID_CONFIGURATION", `Invalid BASE_URL: ${error.message}`, undefined, 2);
    }
    const projectName = process.env.COMPOSE_PROJECT_NAME?.trim() || undefined;
    const config = {
      composeFile,
      projectName,
      service: process.env.ROLLBACK_SMOKE_SERVICE?.trim() || "premise",
      baseUrl,
      tenantId: process.env.PREMISE_TENANT_ID?.trim() || "tenant:rollback-smoke",
      apiToken: process.env.PREMISE_API_TOKEN?.trim() || undefined,
      timeoutMs: integerEnv("ROLLBACK_SMOKE_TIMEOUT_MS", 120_000, 5_000, 900_000),
      pollMs: integerEnv("ROLLBACK_SMOKE_POLL_MS", 2_000, 100, 30_000),
      requestTimeoutMs: integerEnv("ROLLBACK_SMOKE_REQUEST_TIMEOUT_MS", 5_000, 500, 60_000),
      composeTimeoutMs: integerEnv("ROLLBACK_SMOKE_COMPOSE_TIMEOUT_MS", 180_000, 5_000, 900_000)
    };
    audit.inputs = {
      composeFile: relative(repositoryRoot, composeFile),
      composeFileSha256: sha256(composeText),
      runnerSha256: sha256(runnerText),
      projectName: projectName ?? null,
      service: config.service,
      baseUrl,
      tenantId: config.tenantId,
      apiTokenConfigured: config.apiToken !== undefined,
      currentImage,
      previousImage,
      readinessPath: "/readyz",
      timeoutMs: config.timeoutMs,
      pollMs: config.pollMs,
      requestTimeoutMs: config.requestTimeoutMs,
      composeTimeoutMs: config.composeTimeoutMs,
      pullRequested: process.env.ROLLBACK_SMOKE_PULL === "1"
    };

    await phase(audit, "repository-evidence", async () => {
      audit.repository = await gitEvidence(audit);
      audit.commit = audit.repository.commit;
      return audit.repository;
    });

    const preflight = await phase(audit, "preflight", async () => {
      if (process.env.PREMISE_ROLLBACK_CONFIRM !== CONFIRMATION && args.confirm !== CONFIRMATION) throw new SmokeError("CONFIRMATION_REQUIRED", `Set PREMISE_ROLLBACK_CONFIRM=${CONFIRMATION} to authorize a live Compose rollback smoke`, undefined, 2);
      if (currentImage === previousImage) throw new SmokeError("IMAGES_MUST_DIFFER", "Current and previous image references must differ", undefined, 2);
      if (!imageReferenceIsSafeForAudit(currentImage) || !imageReferenceIsSafeForAudit(previousImage)) throw new SmokeError("MUTABLE_IMAGE_REFERENCE", "Use digest references or versioned tags; latest/current/previous/local are rejected by default", { allowOverride: "ROLLBACK_SMOKE_ALLOW_MUTABLE_TAGS=1" }, 2);
      await requiredCommand("docker", ["version", "--format", "{{.Server.Version}}"], { auditCommands: audit.commands, timeoutMs: config.composeTimeoutMs });
      await requiredCommand("docker", ["compose", "version", "--short"], { auditCommands: audit.commands, timeoutMs: config.composeTimeoutMs });
      await dockerCompose(config, ["config", "--quiet"], currentImage, audit);
      const services = await dockerCompose(config, ["config", "--services"], currentImage, audit);
      const serviceNames = services.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
      assertCondition(audit, "compose-service-present", serviceNames.includes(config.service), { service: config.service, services: serviceNames });
      if (process.env.ROLLBACK_SMOKE_PULL === "1") {
        await requiredCommand("docker", ["pull", currentImage], { auditCommands: audit.commands, timeoutMs: config.composeTimeoutMs });
        await requiredCommand("docker", ["pull", previousImage], { auditCommands: audit.commands, timeoutMs: config.composeTimeoutMs });
      }
      const current = await inspectImage(config, currentImage, audit);
      const previous = await inspectImage(config, previousImage, audit);
      assertCondition(audit, "image-ids-differ", current.id !== previous.id, { currentId: current.id, previousId: previous.id });
      audit.evidence.imageReferences = { current, previous };
      return { serviceNames, current, previous };
    });

    const currentImageEvidence = preflight.current;
    const previousImageEvidence = preflight.previous;
    await phase(audit, "deploy-current", async () => {
      await dockerCompose(config, ["up", "-d", "--no-build", config.service], currentImage, audit);
      const ready = await readiness(config, audit, currentImageEvidence, "current image");
      assertCondition(audit, "current-container-image", ready.container.imageId === currentImageEvidence.id, { expected: currentImageEvidence.id, actual: ready.container.imageId });
      audit.evidence.deployments.current = ready;
      return ready;
    });

    const verification = verificationRecord(config, runId);
    const baseline = await phase(audit, "write-current-data", async () => {
      const result = await writeAndReadRecord(config, audit, verification);
      audit.evidence.data = { memoryId: verification.memoryId, marker: verification.marker, before: { recordSha256: result.recordSha256, status: result.status } };
      return { memoryId: verification.memoryId, recordSha256: result.recordSha256 };
    });

    await phase(audit, "rollback-to-previous", async () => {
      await dockerCompose(config, ["up", "-d", "--no-build", "--no-deps", "--force-recreate", config.service], previousImage, audit);
      const ready = await readiness(config, audit, previousImageEvidence, "previous image after rollback");
      assertCondition(audit, "previous-container-image", ready.container.imageId === previousImageEvidence.id, { expected: previousImageEvidence.id, actual: ready.container.imageId });
      audit.evidence.deployments.previous = ready;
      return ready;
    });

    await phase(audit, "verify-rollback-data", async () => {
      const result = await verifyAfterRollback(config, audit, verification, baseline);
      audit.evidence.data.after = { recordSha256: result.recordSha256, status: result.status };
      return result;
    });

    audit.status = "passed";
    audit.ok = true;
    exitCode = 0;
  } catch (error) {
    const smokeError = error instanceof SmokeError ? error : new SmokeError("UNEXPECTED_ERROR", error instanceof Error ? error.message : String(error), undefined, 1);
    audit.status = smokeError.exitCode === 2 ? "blocked" : "failed";
    audit.failure = { code: smokeError.code, message: smokeError.message, ...(smokeError.details === undefined ? {} : { details: smokeError.details }) };
    exitCode = smokeError.exitCode;
  } finally {
    audit.completedAt = now();
    audit.trace = { ...audit.trace, commandCount: audit.commands.length, phaseCount: audit.phases.length };
    try {
      await mkdir(dirname(resultFile), { recursive: true });
      await writeFile(resultFile, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
    } catch (error) {
      audit.status = "failed";
      audit.ok = false;
      audit.failure = { code: "AUDIT_WRITE_FAILED", message: error instanceof Error ? error.message : String(error) };
      exitCode = 1;
    }
    console.log(JSON.stringify({ ok: audit.ok, status: audit.status, runId, artifact: resultFile, failure: audit.failure }));
  }
  return exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof SmokeError ? error.exitCode : 1;
}
