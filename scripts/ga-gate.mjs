import { access, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const acceptanceManifestPath = resolve(repositoryRoot, "spec/ga/acceptance.json");

export const requiredDirectories = Object.freeze([
  "packages/security-core",
  "packages/connector-webhook",
  "packages/sdk",
  "benchmarks/ga-evaluation",
  "benchmarks/ga-evaluation/holdout",
  "benchmarks/ga-load",
  "benchmarks/ga-soak",
  "benchmarks/ga-cost",
  "ops",
  "deploy"
]);

const JSON_EVIDENCE = Object.freeze({
  "dataset-manifest.json": Object.freeze({
    metadata: Object.freeze(["schema", "commit", "generatedAt", "source"]),
    purpose: "dataset identity and hashes"
  }),
  "conformance-v2.json": Object.freeze({ metadata: Object.freeze(["schema", "commit", "generatedAt", "source", "trace"]), purpose: "protocol conformance" }),
  "replay-report.json": Object.freeze({ metadata: Object.freeze(["schema", "commit", "generatedAt", "source", "trace"]), purpose: "deterministic replay" }),
  "security-report.json": Object.freeze({ metadata: Object.freeze(["schema", "commit", "generatedAt", "source", "trace"]), purpose: "cryptographic security" }),
  "postgres-integration.json": Object.freeze({ metadata: Object.freeze(["schema", "commit", "generatedAt", "source", "trace"]), purpose: "real persistence" }),
  "backup-restore.json": Object.freeze({ metadata: Object.freeze(["schema", "commit", "generatedAt", "source", "trace"]), purpose: "backup and restore" }),
  "external-holdout.json": Object.freeze({ metadata: Object.freeze(["schema", "commit", "generatedAt", "source", "trace"]), purpose: "independent external holdout" }),
  "load-full.json": Object.freeze({ metadata: Object.freeze(["schema", "commit", "generatedAt", "source", "trace"]), purpose: "million-scale load" }),
  "postgres-scale.json": Object.freeze({ metadata: Object.freeze(["schema", "commit", "generatedAt", "source", "trace"]), purpose: "real PostgreSQL scale" }),
  "recovery-report.json": Object.freeze({ metadata: Object.freeze(["schema", "commit", "generatedAt", "source", "trace"]), purpose: "failure and recovery" }),
  "operations-smoke.json": Object.freeze({ metadata: Object.freeze(["schema", "commit", "generatedAt", "source", "trace"]), purpose: "production-shaped operations" }),
  "rollback-report.json": Object.freeze({ metadata: Object.freeze(["schema", "commit", "generatedAt", "source", "trace"]), purpose: "deployment rollback" }),
  "soak-availability.json": Object.freeze({ metadata: Object.freeze(["schema", "commit", "generatedAt", "source", "trace"]), purpose: "availability soak" }),
  "cost-report.json": Object.freeze({ metadata: Object.freeze(["schema", "commit", "generatedAt", "source", "trace"]), purpose: "metered cost" }),
  "sdk-contract.json": Object.freeze({ metadata: Object.freeze(["schema", "commit", "generatedAt", "source", "trace"]), purpose: "stable SDK contract" }),
  "openapi-validation.json": Object.freeze({ metadata: Object.freeze(["schema", "commit", "generatedAt", "source", "trace"]), purpose: "OpenAPI validation" })
});

const MARKDOWN_EVIDENCE = new Set(["threat-model.md"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;
const REQUIRED_GATE_IDS = new Set([
  "cryptographic-security",
  "external-blind-evaluation",
  "operations",
  "availability-and-cost"
]);
const RAW_JSONL_TRACE_EVIDENCE = new Set([
  "postgres-scale.json",
  "recovery-report.json",
  "backup-restore.json",
  "postgres-integration.json",
  "sdk-contract.json",
  "openapi-validation.json",
  "soak-availability.json"
]);
const POSTGRES_SCALE_MIN_RECORDS = 1_000_000;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAt(document, path) {
  return path.split(".").reduce((value, key) => (isObject(value) ? value[key] : undefined), document);
}

function addClaimFailure(failures, field, message) {
  failures.push(failure("claims-contract", message, { field }));
}

function requireBooleanClaim(document, path, failures) {
  if (valueAt(document, path) !== true) addClaimFailure(failures, path, `${path} must be true before this evidence can support a GA claim.`);
}

function requireStringClaim(document, path, failures) {
  const value = valueAt(document, path);
  if (typeof value !== "string" || value.trim().length === 0) addClaimFailure(failures, path, `${path} must be a non-empty string before this evidence can support a GA claim.`);
}

function requireHttpsUriClaim(document, path, failures) {
  const value = valueAt(document, path);
  let valid = typeof value === "string" && value.trim().length > 0;
  if (valid) {
    try {
      const parsed = new URL(value);
      valid = parsed.protocol === "https:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) && !parsed.hostname.endsWith(".local");
    } catch {
      valid = false;
    }
  }
  if (!valid) addClaimFailure(failures, path, `${path} must be an external HTTPS URL without local or fixture hosts.`);
}

function requireObjectClaim(document, path, failures) {
  if (!isObject(valueAt(document, path))) addClaimFailure(failures, path, `${path} must be an object before this evidence can support a GA claim.`);
}

function requireSha256Claim(document, path, failures) {
  const value = valueAt(document, path);
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) addClaimFailure(failures, path, `${path} must be a lowercase SHA-256 digest tied to an external review or attestation.`);
}

function requireNumberClaim(document, path, failures, predicate, description) {
  const value = valueAt(document, path);
  if (typeof value !== "number" || !Number.isFinite(value) || !predicate(value)) addClaimFailure(failures, path, `${path} must ${description}.`);
}

function requireIntegerClaim(document, path, failures, predicate, description) {
  const value = valueAt(document, path);
  if (!Number.isSafeInteger(value) || !predicate(value)) addClaimFailure(failures, path, `${path} must ${description}.`);
}

function requireExactClaim(document, path, expected, failures) {
  if (valueAt(document, path) !== expected) addClaimFailure(failures, path, `${path} must equal ${JSON.stringify(expected)} before this evidence can support a GA claim.`);
}

function requirePassedClaim(document, path, failures) {
  if (!["pass", "passed", "PASS"].includes(valueAt(document, path))) addClaimFailure(failures, path, `${path} must report pass or passed before this evidence can support a GA claim.`);
}

function requirePatternClaim(document, path, pattern, failures, description) {
  const value = valueAt(document, path);
  if (typeof value !== "string" || !pattern.test(value)) addClaimFailure(failures, path, `${path} must ${description}.`);
}

function requirePathClaim(document, path, failures) {
  const value = valueAt(document, path);
  const segments = typeof value === "string" ? value.split(/[\\/]/u) : [];
  if (typeof value !== "string" || value.trim().length === 0 || isAbsolute(value) || segments.includes("..")) addClaimFailure(failures, path, `${path} must be a non-empty relative path inside the evidence directory.`);
}

function requirePrefixedSha256Claim(document, path, failures) {
  const value = valueAt(document, path);
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/iu.test(value)) addClaimFailure(failures, path, `${path} must be a SHA-256 digest with the sha256: prefix.`);
}

function requireDigestEquality(document, leftPath, rightPath, failures) {
  const left = valueAt(document, leftPath);
  const right = valueAt(document, rightPath);
  if (typeof left !== "string" || typeof right !== "string" || left !== right) addClaimFailure(failures, leftPath, `${leftPath} and ${rightPath} must contain the same verified digest.`);
}

function requireArrayIncludesClaim(document, path, expected, failures) {
  const value = valueAt(document, path);
  if (!Array.isArray(value) || !value.includes(expected)) addClaimFailure(failures, path, `${path} must include ${JSON.stringify(expected)}.`);
}

function requireContainsClaim(document, path, expected, failures) {
  const value = valueAt(document, path);
  const valid = typeof value === "string" ? value.includes(expected) : Array.isArray(value) && value.includes(expected);
  if (!valid) addClaimFailure(failures, path, `${path} must include ${JSON.stringify(expected)}.`);
}

function requireTraceContract(document, name, failures) {
  requireObjectClaim(document, "trace", failures);
  requirePathClaim(document, "trace.path", failures);
  requirePrefixedSha256Claim(document, "trace.sha256", failures);
  if (RAW_JSONL_TRACE_EVIDENCE.has(name)) requireExactClaim(document, "trace.kind", "raw-jsonl", failures);
}

function loadFullFailures(document) {
  const failures = [];
  requireExactClaim(document, "profile", "full", failures);
  requireExactClaim(document, "scenario", "all", failures);
  requireBooleanClaim(document, "deterministicWorkload", failures);
  requireBooleanClaim(document, "gates.allPassed", failures);
  requireBooleanClaim(document, "gates.node24.passed", failures);
  requireBooleanClaim(document, "gates.correctness.passed", failures);
  requireBooleanClaim(document, "gates.performance.evaluated", failures);
  requireBooleanClaim(document, "gates.performance.passed", failures);
  requireObjectClaim(document, "configuration", failures);
  requireIntegerClaim(document, "configuration.memories", failures, (value) => value >= POSTGRES_SCALE_MIN_RECORDS, `be at least ${POSTGRES_SCALE_MIN_RECORDS}`);
  requireIntegerClaim(document, "configuration.tenants", failures, (value) => value > 0, "be positive");
  requireObjectClaim(document, "load", failures);
  requireBooleanClaim(document, "load.deterministic", failures);
  requireBooleanClaim(document, "load.isolation.passed", failures);
  requireIntegerClaim(document, "load.memoriesRequested", failures, (value) => value >= POSTGRES_SCALE_MIN_RECORDS, `be at least ${POSTGRES_SCALE_MIN_RECORDS}`);
  requireIntegerClaim(document, "load.memoriesApplied", failures, (value) => value >= POSTGRES_SCALE_MIN_RECORDS, `be at least ${POSTGRES_SCALE_MIN_RECORDS}`);
  if (valueAt(document, "load.memoriesApplied") !== valueAt(document, "load.memoriesRequested")) addClaimFailure(failures, "load.memoriesApplied", "load.memoriesApplied must equal load.memoriesRequested; partial load evidence is not eligible.");
  requireIntegerClaim(document, "load.tenants.total", failures, (value) => value === valueAt(document, "load.memoriesApplied"), "equal the applied load count");
  for (const field of ["load.errors.unexpected", "load.errors.worker", "load.errors.journal", "load.errors.store"]) requireExactClaim(document, field, 0, failures);
  requireIntegerClaim(document, "load.latency.samples", failures, (value) => value > 0, "contain at least one latency sample");
  requireNumberClaim(document, "load.latency.p99Ms", failures, (value) => value >= 0, "be finite and non-negative");
  requireNumberClaim(document, "load.throughput.memoriesPerSecond", failures, (value) => value > 0, "be positive");
  requireBooleanClaim(document, "reliability.passed", failures);
  requireIntegerClaim(document, "reliability.memories", failures, (value) => value > 0, "be positive");
  requireExactClaim(document, "reliability.errors.unexpected", 0, failures);
  const requiredScenarios = ["crash-restart", "duplicate-events", "journal-corruption-truncation", "snapshot-recovery", "tenant-isolation"];
  const scenarios = new Map(Array.isArray(document.reliability?.scenarios) ? document.reliability.scenarios.map((scenario) => [scenario?.name, scenario]) : []);
  for (const name of requiredScenarios) {
    if (scenarios.get(name)?.passed !== true) addClaimFailure(failures, `reliability.scenarios.${name}`, `reliability scenario ${name} must be present and passed.`);
  }
  requireExactClaim(document, "interpretation.universalCapacityClaim", false, failures);
  requireContainsClaim(document, "interpretation.payloadScope", "metadata-only synthetic records; no external retrieval, network, or production database", failures);
  requireObjectClaim(document, "trace", failures);
  requireExactClaim(document, "trace.kind", "raw-benchmark-output", failures);
  requireStringClaim(document, "trace.output", failures);
  return failures;
}

function postgresScaleFailures(document, recovery = false) {
  const failures = [];
  requireExactClaim(document, "benchmark", "postgres-production-scale", failures);
  requirePatternClaim(document, "source.kind", /real-postgresql-and-live-http/iu, failures, "identify a real PostgreSQL and live HTTP run");
  requireExactClaim(document, "source.database", "PostgreSQL", failures);
  requireStringClaim(document, "source.baseUrl", failures);
  requireStringClaim(document, "source.tenantId", failures);
  requireStringClaim(document, "database.engine", failures);
  requireExactClaim(document, "database.engine", "PostgreSQL", failures);
  requirePatternClaim(document, "database.version", /\S/iu, failures, "identify the observed PostgreSQL version");
  requireNumberClaim(document, "database.databaseSizeBytes", failures, (value) => value > 0, "be positive");
  requireIntegerClaim(document, "configuration.memoriesExpected", failures, (value) => value >= POSTGRES_SCALE_MIN_RECORDS, `be at least ${POSTGRES_SCALE_MIN_RECORDS}`);
  requireIntegerClaim(document, "configuration.memoriesStored", failures, (value) => value >= POSTGRES_SCALE_MIN_RECORDS, `be at least ${POSTGRES_SCALE_MIN_RECORDS}`);
  requireIntegerClaim(document, "configuration.requests", failures, (value) => value > 0, "be positive");
  requireIntegerClaim(document, "configuration.concurrency", failures, (value) => value > 0, "be positive");
  if (valueAt(document, "configuration.memoriesStored") !== valueAt(document, "database.records")) {
    if (valueAt(document, "database.records") !== undefined) addClaimFailure(failures, "database.records", "database.records must equal configuration.memoriesStored when present.");
  }
  requireIntegerClaim(document, "metrics.requests", failures, (value) => value > 0, "be positive");
  requireExactClaim(document, "metrics.failed", 0, failures);
  requireNumberClaim(document, "metrics.errorRate", failures, (value) => value <= (document.configuration?.maxErrorRate ?? 0.001), `be at or below ${document.configuration?.maxErrorRate ?? 0.001}`);
  requireNumberClaim(document, "metrics.latency.p95Ms", failures, (value) => value <= (document.configuration?.maxP95Ms ?? 500), `be at or below ${document.configuration?.maxP95Ms ?? 500} ms`);
  requireNumberClaim(document, "metrics.latency.p99Ms", failures, (value) => value <= (document.configuration?.maxP99Ms ?? 2_000), `be at or below ${document.configuration?.maxP99Ms ?? 2_000} ms`);
  requireObjectClaim(document, "metrics.byOperation", failures);
  requireObjectClaim(document, "eligibility", failures);
  requireBooleanClaim(document, "eligibility.eligibleForGa", failures);
  for (const field of [
    "eligibility.checks.realPostgresRecords.passed",
    "eligibility.checks.requestCount.passed",
    "eligibility.checks.errorRate.passed",
    "eligibility.checks.p95.passed",
    "eligibility.checks.p99.passed"
  ]) requireBooleanClaim(document, field, failures);
  for (const operation of ["retrieve", "query", "register"]) {
    requireObjectClaim(document, `metrics.byOperation.${operation}`, failures);
    requireIntegerClaim(document, `metrics.byOperation.${operation}.requests`, failures, (value) => value > 0, "be positive");
    requireExactClaim(document, `metrics.byOperation.${operation}.failed`, 0, failures);
    requireNumberClaim(document, `metrics.byOperation.${operation}.latency.p95Ms`, failures, (value) => value >= 0, "be finite and non-negative");
    requireNumberClaim(document, `metrics.byOperation.${operation}.latency.p99Ms`, failures, (value) => value >= 0, "be finite and non-negative");
    requireBooleanClaim(document, `eligibility.byOperation.${operation}.eligibleForGa`, failures);
    requireBooleanClaim(document, `eligibility.checks.byOperation.${operation}.requestCount.passed`, failures);
    requireBooleanClaim(document, `eligibility.checks.byOperation.${operation}.errorRate.passed`, failures);
    requireBooleanClaim(document, `eligibility.checks.byOperation.${operation}.p95.passed`, failures);
    requireBooleanClaim(document, `eligibility.checks.byOperation.${operation}.p99.passed`, failures);
  }
  requireArrayIncludesClaim(document, "interpretation.claimsNotSupported", "universal capacity", failures);
  requireTraceContract(document, recovery ? "recovery-report.json" : "postgres-scale.json", failures);
  if (recovery) {
    requireObjectClaim(document, "recovery", failures);
    for (const field of [
      "recovery.restart.observed",
      "recovery.restart.readinessPassed",
      "recovery.restart.dataAvailable",
      "recovery.corruption.injected",
      "recovery.corruption.rejected",
      "recovery.corruption.recovered",
      "recovery.dataPreserved"
    ]) requireBooleanClaim(document, field, failures);
    requireSha256Claim(document, "recovery.before.recordSha256", failures);
    requireSha256Claim(document, "recovery.after.recordSha256", failures);
    requireDigestEquality(document, "recovery.before.recordSha256", "recovery.after.recordSha256", failures);
    requirePatternClaim(document, "trace.path", /recovery/iu, failures, "identify the recovery trace");
  }
  return failures;
}

function backupRestoreFailures(document) {
  const failures = [];
  requirePassedClaim(document, "status", failures);
  requireBooleanClaim(document, "ok", failures);
  requirePatternClaim(document, "source.kind", /real.*postgres|postgres.*real/iu, failures, "identify a real PostgreSQL run");
  requireStringClaim(document, "tenantId", failures);
  requireObjectClaim(document, "backup", failures);
  requireStringClaim(document, "backup.format", failures);
  if (![
    "premise-v2-backup-ndjson",
    "premise-v2-backup"
  ].includes(valueAt(document, "backup.format"))) addClaimFailure(failures, "backup.format", "backup.format must identify a supported PREMiSE backup format.");
  requirePathClaim(document, "backup.path", failures);
  requirePrefixedSha256Claim(document, "backup.fileSha256", failures);
  requireSha256Claim(document, "backup.sha256", failures);
  requireIntegerClaim(document, "backup.records", failures, (value) => value > 0, "be positive");
  requireIntegerClaim(document, "backup.events", failures, (value) => value >= 0, "be non-negative");
  requireObjectClaim(document, "restore", failures);
  requireBooleanClaim(document, "restore.verified", failures);
  requireStringClaim(document, "restore.verifiedIn", failures);
  requireSha256Claim(document, "restore.sha256", failures);
  requireIntegerClaim(document, "restore.records", failures, (value) => value > 0, "be positive");
  requireIntegerClaim(document, "restore.events", failures, (value) => value >= 0, "be non-negative");
  requireDigestEquality(document, "backup.sha256", "restore.sha256", failures);
  if (valueAt(document, "backup.records") !== valueAt(document, "restore.records")) addClaimFailure(failures, "restore.records", "restore.records must equal backup.records.");
  if (valueAt(document, "backup.events") !== valueAt(document, "restore.events")) addClaimFailure(failures, "restore.events", "restore.events must equal backup.events.");
  requireTraceContract(document, "backup-restore.json", failures);
  return failures;
}

function postgresIntegrationFailures(document) {
  const failures = [];
  requirePassedClaim(document, "status", failures);
  requireBooleanClaim(document, "ok", failures);
  requirePatternClaim(document, "source.kind", /real.*postgres|postgres.*real/iu, failures, "identify a real PostgreSQL run");
  requireExactClaim(document, "database.engine", "PostgreSQL", failures);
  requireStringClaim(document, "database.version", failures);
  requireBooleanClaim(document, "migrations.applied", failures);
  requireStringClaim(document, "migrations.version", failures);
  requireBooleanClaim(document, "tenantIsolation.verified", failures);
  requireBooleanClaim(document, "tests.passed", failures);
  requireIntegerClaim(document, "tests.total", failures, (value) => value > 0, "be positive");
  requireExactClaim(document, "tests.failed", 0, failures);
  requireTraceContract(document, "postgres-integration.json", failures);
  return failures;
}

function apiCommonFailures(document) {
  const failures = [];
  requirePassedClaim(document, "status", failures);
  requireBooleanClaim(document, "ok", failures);
  requireExactClaim(document, "apiVersion", "premise/2", failures);
  requireBooleanClaim(document, "tests.passed", failures);
  requireIntegerClaim(document, "tests.total", failures, (value) => value > 0, "be positive");
  requireExactClaim(document, "tests.failed", 0, failures);
  for (const field of ["checks.schemas", "checks.pagination", "checks.typedErrors", "checks.compatibility"]) requireBooleanClaim(document, field, failures);
  requireStringClaim(document, "compatibility.policy", failures);
  return failures;
}

function sdkContractFailures(document) {
  const failures = apiCommonFailures(document);
  requireObjectClaim(document, "sdk", failures);
  requireStringClaim(document, "sdk.package", failures);
  requireStringClaim(document, "sdk.version", failures);
  requireTraceContract(document, "sdk-contract.json", failures);
  return failures;
}

function openapiValidationFailures(document) {
  const failures = apiCommonFailures(document);
  requireObjectClaim(document, "spec", failures);
  requirePathClaim(document, "spec.path", failures);
  requireSha256Claim(document, "spec.sha256", failures);
  requireObjectClaim(document, "validation", failures);
  requireBooleanClaim(document, "validation.passed", failures);
  requireIntegerClaim(document, "validation.operations", failures, (value) => value > 0, "be positive");
  requireIntegerClaim(document, "validation.schemas", failures, (value) => value > 0, "be positive");
  requireTraceContract(document, "openapi-validation.json", failures);
  return failures;
}

function securityReportFailures(document) {
  const failures = [];
  requireExactClaim(document, "status", "pass", failures);
  requireExactClaim(document, "claims.eligibleForGa", true, failures);

  const provider = valueAt(document, "securityControls.keyManagement.provider");
  if (typeof provider !== "string" || !/(?:kms|hsm)/iu.test(provider) || /(?:memory|local|fixture|mock)/iu.test(provider)) {
    addClaimFailure(failures, "securityControls.keyManagement.provider", "key management must name an external KMS/HSM; an in-process, local or fixture key ring is not GA evidence.");
  }
  for (const field of [
    "securityControls.keyManagement.external",
    "securityControls.keyManagement.rotationObserved",
    "securityControls.keyManagement.revocationObserved",
    "securityControls.keyManagement.recoveryObserved",
    "securityControls.keyManagement.leastPrivilegeReviewed",
    "securityControls.transport.tlsEnforced",
    "securityControls.identity.oidcOrEquivalent",
    "securityControls.identity.authorizationReviewed",
    "securityControls.tenantIsolation.verified",
    "securityControls.audit.durable",
    "securityControls.audit.tamperEvidenceVerified",
    "securityControls.audit.recoveryObserved"
  ]) requireBooleanClaim(document, field, failures);

  requireExactClaim(document, "independentReview.status", "pass", failures);
  requireBooleanClaim(document, "independentReview.separateReviewer", failures);
  requireStringClaim(document, "independentReview.reviewerId", failures);
  requireHttpsUriClaim(document, "independentReview.reviewReportUri", failures);
  requireSha256Claim(document, "independentReview.reviewReportSha256", failures);
  requireExactClaim(document, "independentReview.attestation.verified", true, failures);
  requireExactClaim(document, "independentReview.attestation.signatureScheme", "ed25519", failures);
  requireNumberClaim(document, "independentReview.openCriticalFindings", failures, (value) => value === 0, "be exactly 0");
  requireNumberClaim(document, "independentReview.openHighFindings", failures, (value) => value === 0, "be exactly 0");
  return failures;
}

function threatModelFailures(raw) {
  const failures = [];
  const markers = [
    ["security-review", /(?:security review|revisi[oó]n de seguridad)/iu],
    ["kms-hsm", /KMS\s*\/\s*HSM[\s\S]{0,120}(?:external|externo|observed|integrat|custod)/iu],
    ["tls", /\bTLS\b[\s\S]{0,120}(?:enforced|obligatorio|terminat|observed|aplic)/iu],
    ["oidc-identity", /(?:OIDC|OpenID|identity|identidad)[\s\S]{0,120}(?:observed|enforced|reviewed|configured|integrat|obligat)/iu],
    ["independent-review", /(?:independent review|revisi[oó]n independiente|revisi[oó]n externa)[\s\S]{0,120}(?:complete|completed|pass|completa|aprobada)/iu],
    ["open-critical-findings", /(?:open critical findings|hallazgos cr[ií]ticos abiertos)\s*[:=-]?\s*(?:0|zero|ninguno)/iu],
    ["non-universal-security-claim", /(?:not a universal|no es universal|no.*compliance|no.*autoridad universal|not.*compliant)/iu]
  ];
  for (const [field, pattern] of markers) if (!pattern.test(raw)) addClaimFailure(failures, field, `threat-model.md must explicitly document the ${field} boundary and its observed status.`);
  return failures;
}

function holdoutFailures(document, manifest) {
  const failures = [];
  const thresholds = manifest.thresholds ?? {};
  requireExactClaim(document, "status", "INDEPENDENT_EVIDENCE", failures);
  requireExactClaim(document, "evidence.class", "independent", failures);
  requireBooleanClaim(document, "evidence.independent", failures);
  requireBooleanClaim(document, "evidence.eligibleForPublicClaim", failures);
  requireBooleanClaim(document, "eligibleForPublicClaim", failures);
  requireExactClaim(document, "benchmark.split", "holdout", failures);
  requireNumberClaim(document, "benchmark.tasks", failures, (value) => value >= (thresholds.holdoutTasksMin ?? 200), `be at least ${thresholds.holdoutTasksMin ?? 200}`);
  requireNumberClaim(document, "metrics.correctPer100", failures, (value) => value / 100 >= (thresholds.holdoutAccuracyMin ?? 0.95), `meet the holdout accuracy threshold of ${thresholds.holdoutAccuracyMin ?? 0.95}`);
  requireNumberClaim(document, "metrics.freshPer100Eligible", failures, (value) => value / 100 >= (thresholds.freshnessSlaMin ?? 0.99), `meet the freshness threshold of ${thresholds.freshnessSlaMin ?? 0.99}`);
  requireNumberClaim(document, "metrics.freshnessEligible", failures, (value) => value > 0, "have a non-zero freshness denominator");
  requireBooleanClaim(document, "verification.externalImmutable", failures);
  requireBooleanClaim(document, "verification.labelsLoadedAfterCandidate", failures);
  requireExactClaim(document, "verification.labelsSentToCandidate", false, failures);
  requireExactClaim(document, "verification.fixtureEvidenceUsed", false, failures);
  requireExactClaim(document, "verification.writeRequests", 0, failures);
  requireBooleanClaim(document, "evidence.attestation.verified", failures);
  requireHttpsUriClaim(document, "evidence.attestation.url", failures);
  requireSha256Claim(document, "evidence.attestation.sha256", failures);
  return failures;
}

function soakFailures(document, manifest) {
  const failures = [];
  const thresholds = manifest.thresholds ?? {};
  requireBooleanClaim(document, "setup.ok", failures);
  requireBooleanClaim(document, "acceptance.passed", failures);
  requireBooleanClaim(document, "postgresTelemetry.available", failures);
  requireBooleanClaim(document, "eligibility.eligibleForGa", failures);
  requireExactClaim(document, "eligibility.classification", "ga-eligible", failures);
  requireNumberClaim(document, "window.activeDurationMs", failures, (value) => value >= (thresholds.availabilityMeasurementMinSeconds ?? 3600) * 1000, `cover at least ${thresholds.availabilityMeasurementMinSeconds ?? 3600} seconds`);
  requireNumberClaim(document, "metrics.requests", failures, (value) => value >= (thresholds.availabilityMeasurementMinRequests ?? 10_000), `include at least ${thresholds.availabilityMeasurementMinRequests ?? 10_000} requests`);
  requireNumberClaim(document, "metrics.availabilityRate", failures, (value) => value >= (thresholds.availabilityMin ?? 0.999), `meet availability ${thresholds.availabilityMin ?? 0.999}`);
  requireNumberClaim(document, "metrics.errorRate", failures, (value) => value <= (thresholds.errorRateMax ?? 0.001), `stay at or below error rate ${thresholds.errorRateMax ?? 0.001}`);
  requireNumberClaim(document, "metrics.latency.p95Ms", failures, (value) => value <= (thresholds.p95LatencyMsMax ?? 500), `stay at or below p95 ${thresholds.p95LatencyMsMax ?? 500} ms`);
  requireNumberClaim(document, "metrics.latency.p99Ms", failures, (value) => value <= (thresholds.p99LatencyMsMax ?? 2_000), `stay at or below p99 ${thresholds.p99LatencyMsMax ?? 2_000} ms`);
  requireStringClaim(document, "trace.path", failures);
  if (typeof valueAt(document, "trace.sha256") !== "string" || !/^sha256:[0-9a-f]{64}$/iu.test(valueAt(document, "trace.sha256"))) addClaimFailure(failures, "trace.sha256", "soak evidence must reference a complete raw JSONL trace by SHA-256.");
  return failures;
}

function costFailures(document, manifest) {
  const failures = [];
  const threshold = manifest.thresholds?.costPerThousandOperationsUsdMax ?? 0.05;
  requireBooleanClaim(document, "eligibleForGa", failures);
  requireBooleanClaim(document, "measurement.real", failures);
  if (!["provider-billing", "metered-infrastructure"].includes(document.mode)) addClaimFailure(failures, "mode", "cost evidence must come from provider billing or metered infrastructure, never a modeled-only run.");
  requireNumberClaim(document, "workload.operations", failures, (value) => value > 0, "cover a positive number of operations");
  requireExactClaim(document, "cost.currency", "USD", failures);
  requireBooleanClaim(document, "cost.thresholdPassed", failures);
  requireNumberClaim(document, "cost.perThousandOperationsUsd", failures, (value) => value <= threshold, `be at or below ${threshold} USD per 1,000 operations`);
  requireBooleanClaim(document, "evidence.evidenceComplete", failures);
  requireBooleanClaim(document, "evidence.realMeasurement", failures);
  requireBooleanClaim(document, "evidence.eligibleCostEvidence", failures);
  return failures;
}

function rollbackFailures(document) {
  const failures = [];
  requireExactClaim(document, "status", "passed", failures);
  requireBooleanClaim(document, "ok", failures);
  const currentId = valueAt(document, "evidence.imageReferences.current.id");
  const previousId = valueAt(document, "evidence.imageReferences.previous.id");
  if (typeof currentId !== "string" || currentId.length === 0 || currentId === previousId) addClaimFailure(failures, "evidence.imageReferences", "rollback evidence must identify two different immutable image identities.");
  if (typeof previousId !== "string" || previousId.length === 0) addClaimFailure(failures, "evidence.imageReferences.previous.id", "rollback evidence must identify the previous image by stable identity.");
  for (const field of ["evidence.deployments.current", "evidence.deployments.previous"]) requireObjectClaim(document, field, failures);
  for (const field of ["evidence.data.before.recordSha256", "evidence.data.after.recordSha256"]) requireStringClaim(document, field, failures);
  if (valueAt(document, "evidence.data.before.recordSha256") !== valueAt(document, "evidence.data.after.recordSha256")) addClaimFailure(failures, "evidence.data", "rollback must preserve the verified record digest across A→B→A.");
  const phaseNames = Array.isArray(document.phases) ? new Set(document.phases.filter((phase) => phase?.status === "passed").map((phase) => phase.name)) : new Set();
  for (const phase of ["deploy-current", "write-current-data", "rollback-to-previous", "verify-rollback-data"]) if (!phaseNames.has(phase)) addClaimFailure(failures, `phases.${phase}`, `rollback evidence must contain a passed ${phase} phase.`);
  return failures;
}

function semanticFailures(name, document, raw, manifest) {
  switch (name) {
    case "load-full.json": return loadFullFailures(document);
    case "postgres-scale.json": return postgresScaleFailures(document);
    case "recovery-report.json": return postgresScaleFailures(document, true);
    case "backup-restore.json": return backupRestoreFailures(document);
    case "postgres-integration.json": return postgresIntegrationFailures(document);
    case "sdk-contract.json": return sdkContractFailures(document);
    case "openapi-validation.json": return openapiValidationFailures(document);
    case "security-report.json": return securityReportFailures(document);
    case "threat-model.md": return threatModelFailures(raw);
    case "external-holdout.json": return holdoutFailures(document, manifest);
    case "soak-availability.json": return soakFailures(document, manifest);
    case "cost-report.json": return costFailures(document, manifest);
    case "rollback-report.json": return rollbackFailures(document);
    default: return [];
  }
}

async function referencedFileFailures(evidenceRoot, pathValue, declaredDigest, field, { prefixed = false, jsonl = false } = {}) {
  const failures = [];
  if (typeof pathValue !== "string" || pathValue.trim().length === 0) return failures;
  const resolvedPath = resolve(evidenceRoot, pathValue);
  if (!isPathInside(evidenceRoot, resolvedPath)) {
    addClaimFailure(failures, field, "the referenced evidence file must remain inside the evidence directory.");
    return failures;
  }
  let bytes;
  try {
    const info = await stat(resolvedPath);
    if (!info.isFile()) {
      addClaimFailure(failures, field, "the referenced evidence path must be a regular file.");
      return failures;
    }
    bytes = await readFile(resolvedPath);
  } catch (error) {
    addClaimFailure(failures, field, `the referenced evidence file cannot be read: ${error.message}`);
    return failures;
  }
  if (bytes.byteLength === 0) {
    addClaimFailure(failures, field, "the referenced evidence file must not be empty.");
    return failures;
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const actualDigest = prefixed ? `sha256:${digest}` : digest;
  if (actualDigest !== declaredDigest) addClaimFailure(failures, field, "the declared digest does not match the uploaded evidence bytes.");
  if (jsonl) {
    const lines = bytes.toString("utf8").split(/\r?\n/u).filter((line) => line.trim().length > 0);
    if (lines.length === 0) addClaimFailure(failures, field, "the raw JSONL evidence must contain at least one record.");
    for (const [index, line] of lines.entries()) {
      try {
        JSON.parse(line);
      } catch {
        addClaimFailure(failures, field, `the raw JSONL evidence contains invalid JSON at line ${index + 1}.`);
        break;
      }
    }
  }
  return failures;
}

async function rawTraceFailures(evidenceRoot, name, document) {
  if (!RAW_JSONL_TRACE_EVIDENCE.has(name)) return [];
  return referencedFileFailures(
    evidenceRoot,
    valueAt(document, "trace.path"),
    valueAt(document, "trace.sha256"),
    "trace.sha256",
    { prefixed: true, jsonl: true }
  );
}

async function rawSupportingFileFailures(evidenceRoot, name, document) {
  if (name === "backup-restore.json") {
    return referencedFileFailures(
      evidenceRoot,
      valueAt(document, "backup.path"),
      valueAt(document, "backup.fileSha256"),
      "backup.fileSha256",
      { prefixed: true, jsonl: valueAt(document, "backup.format") === "premise-v2-backup-ndjson" }
    );
  }
  if (name === "openapi-validation.json") {
    return referencedFileFailures(
      evidenceRoot,
      valueAt(document, "spec.path"),
      valueAt(document, "spec.sha256"),
      "spec.sha256"
    );
  }
  return [];
}

function failure(code, message, extra = {}) {
  return { code, message, ...extra };
}

function meaningful(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0 && value.some(meaningful);
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return typeof value === "number" && Number.isFinite(value);
}

function validTimestamp(value) {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function validCommit(value) {
  if (typeof value === "string") return /^[0-9a-f]{40}$/iu.test(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => key !== "value" && key !== "source")) return false;
  return typeof value.value === "string" && /^[0-9a-f]{40}$/iu.test(value.value) && (value.source === undefined || typeof value.source === "string" && value.source.trim().length > 0);
}

function independenceSignal(document) {
  if (document?.independent === true) return { value: true, source: "independent" };
  if (document?.independent === false) return { value: false, source: "independent" };
  if (document?.evidence?.independent === true) return { value: true, source: "evidence.independent" };
  if (document?.evidence?.independent === false) return { value: false, source: "evidence.independent" };
  if (document?.verification?.independentReproduction === true) return { value: true, source: "verification.independentReproduction" };
  if (document?.verification?.independentReproduction === false) return { value: false, source: "verification.independentReproduction" };
  if (document?.verification?.independent === true) return { value: true, source: "verification.independent" };
  if (document?.verification?.independent === false) return { value: false, source: "verification.independent" };
  return { value: null, source: null };
}

function metadataRequirementFor(name) {
  return JSON_EVIDENCE[name] ?? { metadata: ["schema", "commit", "generatedAt", "source", "trace"], purpose: "GA evidence" };
}

function isPathInside(parent, child) {
  const childRelative = relative(resolve(parent), resolve(child));
  return childRelative === "" || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

export function listEvidenceRequirements(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !Array.isArray(manifest.gates)) {
    throw new TypeError("Acceptance manifest must contain a gates array before evidence can be inspected.");
  }
  return manifest.gates.flatMap((gate) => gate.evidence.map((name) => ({
    name,
    gateId: gate.id,
    owner: gate.owner,
    external: name === "external-holdout.json"
  })));
}

export async function loadAcceptanceManifest(manifestPath = acceptanceManifestPath) {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function inspectEvidenceFile(evidenceRoot, requirement, manifest) {
  const result = {
    name: requirement.name,
    gateId: requirement.gateId,
    owner: requirement.owner,
    required: true,
    presence: { exists: false, nonEmpty: false, bytes: 0 },
    verified: false,
    independent: null,
    eligible: false,
    failures: [],
    incompatibilities: []
  };
  const filePath = resolve(evidenceRoot, requirement.name);
  if (!isPathInside(evidenceRoot, filePath)) {
    result.failures.push(failure("unsafe-path", `Evidence path escapes the evidence directory: ${requirement.name}`));
    return result;
  }

  let fileInfo;
  try {
    fileInfo = await stat(filePath);
    result.presence.exists = true;
  } catch {
    result.failures.push(failure("missing", `Required evidence file is missing: ${requirement.name}`));
    return result;
  }
  if (!fileInfo.isFile()) {
    result.failures.push(failure("not-a-file", `Required evidence path is not a regular file: ${requirement.name}`));
    return result;
  }

  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    result.failures.push(failure("unreadable", `Required evidence file cannot be read: ${requirement.name}: ${error.message}`));
    return result;
  }
  result.presence.bytes = Buffer.byteLength(raw, "utf8");
  result.presence.nonEmpty = raw.trim().length > 0;
  if (!result.presence.nonEmpty) {
    result.failures.push(failure("empty", `Required evidence file is empty: ${requirement.name}`));
    return result;
  }

  if (MARKDOWN_EVIDENCE.has(requirement.name) || requirement.name.endsWith(".md")) {
    const semantic = semanticFailures(requirement.name, null, raw, manifest);
    if (semantic.length > 0) {
      result.failures.push(...semantic);
      result.incompatibilities.push({
        code: "claims-contract",
        message: `${requirement.name} is present but does not document the mandatory controls and claim boundaries.`
      });
      return result;
    }
    result.verified = true;
    result.eligible = true;
    return result;
  }

  let document;
  try {
    document = JSON.parse(raw.replace(/^\uFEFF/u, ""));
  } catch (error) {
    const item = failure("invalid-json", `Required evidence JSON is invalid: ${requirement.name}: ${error.message}`);
    result.failures.push(item);
    result.incompatibilities.push({
      code: "legacy-artifact-format",
      message: `The present artifact cannot be promoted to GA evidence because it is not valid JSON; its bytes were not rewritten or interpreted.`
    });
    return result;
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    result.failures.push(failure("json-document", `Required evidence JSON must be an object: ${requirement.name}`));
    result.incompatibilities.push({
      code: "legacy-artifact-shape",
      message: `The present artifact has no GA evidence document object; the collector will not manufacture one.`
    });
    return result;
  }

  const requiredMetadata = metadataRequirementFor(requirement.name).metadata;
  for (const field of requiredMetadata) {
    if (!meaningful(document[field])) {
      result.failures.push(failure("metadata-missing", `${requirement.name} is missing non-empty metadata field '${field}'.`, { field }));
    }
  }
  for (const field of ["schema", "format"]) {
    if (meaningful(document[field]) && typeof document[field] !== "string") {
      result.failures.push(failure("metadata-invalid", `${requirement.name} metadata field '${field}' must be a non-empty string.`, { field }));
    }
  }
  if (meaningful(document.schema) && meaningful(document.format) && document.schema !== document.format) {
    result.failures.push(failure("schema-mismatch", `${requirement.name} declares different schema and format identifiers.`, { fields: ["schema", "format"] }));
  }
  if (meaningful(document.generatedAt) && !validTimestamp(document.generatedAt)) {
    result.failures.push(failure("metadata-invalid", `${requirement.name} has an invalid generatedAt timestamp.`, { field: "generatedAt" }));
  }
  if (meaningful(document.commit) && !validCommit(document.commit)) {
    result.failures.push(failure("metadata-invalid", `${requirement.name} must bind evidence to a full 40-character commit SHA.`, { field: "commit" }));
  }
  if (result.failures.length > 0) {
    result.incompatibilities.push({
      code: "ga-evidence-metadata-contract",
      message: `The present ${requirement.name} artifact does not satisfy the GA metadata contract (${requiredMetadata.join(", ")}); missing metadata is reported, not silently inferred.`
    });
    return result;
  }

  const semantic = [
    ...semanticFailures(requirement.name, document, raw, manifest),
    ...await rawTraceFailures(evidenceRoot, requirement.name, document),
    ...await rawSupportingFileFailures(evidenceRoot, requirement.name, document)
  ];
  if (semantic.length > 0) {
    result.failures.push(...semantic);
    result.incompatibilities.push({
      code: "claims-contract",
      message: `${requirement.name} satisfies the metadata shape but not the required evidence semantics; it cannot support a GA claim.`
    });
    return result;
  }

  result.verified = true;
  const signal = independenceSignal(document);
  result.independent = signal.value;
  result.independenceSignal = signal.source;
  if (requirement.external && result.independent !== true) {
    result.failures.push(failure(
      "independence-required",
      `${requirement.name} is structurally valid but is not independently reproduced; set independent=true or verification.independentReproduction=true only when that claim is evidenced.`
    ));
    result.eligible = false;
  } else {
    result.eligible = true;
  }
  return result;
}

function summarizeEvidence(artifacts) {
  const summary = {
    required: artifacts.length,
    present: artifacts.filter((artifact) => artifact.presence.exists && artifact.presence.nonEmpty).length,
    verified: artifacts.filter((artifact) => artifact.verified).length,
    independent: artifacts.filter((artifact) => artifact.independent === true).length,
    eligible: artifacts.filter((artifact) => artifact.eligible).length,
    presence: artifacts.every((artifact) => artifact.presence.exists && artifact.presence.nonEmpty),
    verifiedAll: artifacts.every((artifact) => artifact.verified),
    independentRequired: artifacts.filter((artifact) => artifact.name === "external-holdout.json").length,
    independentAll: artifacts.filter((artifact) => artifact.name === "external-holdout.json").every((artifact) => artifact.independent === true),
    eligibleAll: artifacts.every((artifact) => artifact.eligible),
    failures: artifacts.flatMap((artifact) => artifact.failures.map((item) => ({ artifact: artifact.name, gateId: artifact.gateId, ...item }))),
    incompatibilities: artifacts.flatMap((artifact) => artifact.incompatibilities.map((item) => ({ artifact: artifact.name, gateId: artifact.gateId, ...item })))
  };
  return summary;
}

export async function inspectEvidenceDirectory(evidenceRoot, manifest) {
  const requirements = listEvidenceRequirements(manifest);
  const artifacts = [];
  for (const requirement of requirements) artifacts.push(await inspectEvidenceFile(evidenceRoot, requirement, manifest));
  return { ...summarizeEvidence(artifacts), artifacts };
}

function implementationFailures(manifest) {
  const failures = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [failure("manifest-shape", "Acceptance manifest must be a JSON object.")];
  }
  if (manifest.schemaVersion !== "premise/ga-1" || manifest.release !== "2.0.0") {
    failures.push(failure("manifest-version", "Acceptance manifest must declare schemaVersion premise/ga-1 and release 2.0.0."));
  }
  for (const [field, message] of [
    ["fixturesAreNotExternalEvidence", "Truth policy must reject fixture-only claims."],
    ["claimsRequireRawTraces", "Truth policy must require raw traces for claims."],
    ["claimsRequireIndependentReproduction", "Truth policy must require independent reproduction for claims."],
    ["missingEvidenceBlocksGa", "Truth policy must block GA when evidence is missing."]
  ]) if (manifest.truthPolicy?.[field] !== true) failures.push(failure("truth-policy", message, { field }));
  if (!Array.isArray(manifest.gates) || manifest.gates.length < 7) {
    failures.push(failure("manifest-gates", "Acceptance manifest must contain all GA gates."));
    return failures;
  }
  const ids = new Set();
  const evidenceNames = new Set();
  for (const gate of manifest.gates) {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
      failures.push(failure("gate-shape", "Each acceptance gate must be a JSON object."));
      continue;
    }
    if (typeof gate.id !== "string" || ids.has(gate.id)) failures.push(failure("gate-id", `Gate id is missing or duplicated: ${gate.id ?? "unknown"}`));
    ids.add(gate.id);
    if (!Array.isArray(gate.evidence) || gate.evidence.length === 0) {
      failures.push(failure("gate-evidence", `Gate ${gate.id} has no evidence requirements.`));
      continue;
    }
    for (const name of gate.evidence) {
      if (typeof name !== "string" || name.trim().length === 0) {
        failures.push(failure("evidence-name", `Gate ${gate.id} contains an empty or non-string evidence name.`));
      } else if (evidenceNames.has(name)) {
        failures.push(failure("evidence-duplicate", `Evidence file is required more than once: ${name}`));
      }
      evidenceNames.add(name);
    }
  }
  for (const gateId of REQUIRED_GATE_IDS) if (!ids.has(gateId)) failures.push(failure("required-gate", `Acceptance manifest is missing mandatory claim gate ${gateId}.`));
  return failures;
}

async function pathExists(root, relativePath) {
  try {
    await access(resolve(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

export async function runGaGate({ rootDir = repositoryRoot, manifestPath = resolve(rootDir, "spec/ga/acceptance.json"), strict = false, evidenceRoot } = {}) {
  const result = {
    gate: "PREMiSE v2.0 GA",
    strict,
    status: strict ? "evidence-pending" : "implementation-checked",
    failures: [],
    incompatibilities: [],
    presence: null,
    verified: null,
    independent: null,
    eligible: null,
    evidence: null
  };
  let manifest;
  try {
    manifest = await loadAcceptanceManifest(manifestPath);
  } catch (error) {
    result.failures.push(failure("manifest-unreadable", `Acceptance manifest is not readable JSON: ${error.message}`));
    result.status = "failed";
    return { ...result, exitCode: 1 };
  }

  const manifestFailures = implementationFailures(manifest);
  result.failures.push(...manifestFailures);
  const missingDirectories = [];
  for (const directory of requiredDirectories) if (!(await pathExists(rootDir, directory))) missingDirectories.push(directory);
  if (missingDirectories.length > 0) result.failures.push(failure("implementation-modules", `GA implementation modules are missing: ${missingDirectories.join(", ")}`));
  const implementationFailureCount = result.failures.length;

  if (strict && !evidenceRoot) {
    result.failures.push(failure("evidence-root-required", "--strict requires PREMISE_GA_EVIDENCE_DIR."));
  }
  if (evidenceRoot) {
    const resolvedEvidenceRoot = resolve(evidenceRoot);
    try {
      const info = await stat(resolvedEvidenceRoot);
      if (!info.isDirectory()) {
        result.failures.push(failure("evidence-root", `Evidence path is not a directory: ${resolvedEvidenceRoot}`));
      } else if (manifestFailures.length > 0) {
        result.failures.push(failure("evidence-skipped", "Evidence inspection was skipped because the acceptance manifest is structurally invalid."));
      } else {
        result.evidence = await inspectEvidenceDirectory(resolvedEvidenceRoot, manifest);
        result.presence = result.evidence.presence;
        result.verified = result.evidence.verifiedAll;
        result.independent = result.evidence.independentAll;
        result.eligible = strict && result.evidence.eligibleAll;
        result.incompatibilities.push(...result.evidence.incompatibilities);
        result.failures.push(...result.evidence.failures);
      }
    } catch (error) {
      result.failures.push(failure("evidence-root", `Evidence directory does not exist or is not readable: ${resolvedEvidenceRoot}: ${error.message}`));
    }
  }

  const evidenceFailureCount = result.evidence?.failures.length ?? Math.max(0, result.failures.length - implementationFailureCount);
  if (implementationFailureCount > 0) {
    result.status = "implementation-failed";
  } else if (evidenceFailureCount > 0) {
    result.status = strict ? "evidence-failed" : "evidence-incomplete";
  } else if (strict) {
    result.status = "evidence-checked";
  }
  return { ...result, exitCode: implementationFailureCount > 0 || (strict && evidenceFailureCount > 0) ? 1 : 0 };
}

function isMain() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const result = await runGaGate({
    strict: process.argv.includes("--strict"),
    evidenceRoot: process.env.PREMISE_GA_EVIDENCE_DIR
  });
  console.log(JSON.stringify({
    ...result,
    thresholds: (await loadAcceptanceManifest().catch(() => ({}))).thresholds
  }, null, 2));
  for (const item of result.failures) console.error(`GA gate: ${item.message}`);
  process.exitCode = result.exitCode;
}
