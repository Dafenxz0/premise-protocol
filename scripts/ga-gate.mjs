import { access, readFile, stat } from "node:fs/promises";
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

async function inspectEvidenceFile(evidenceRoot, requirement) {
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
  for (const requirement of requirements) artifacts.push(await inspectEvidenceFile(evidenceRoot, requirement));
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
  if (manifest.truthPolicy?.fixturesAreNotExternalEvidence !== true) {
    failures.push(failure("truth-policy", "Truth policy must reject fixture-only claims."));
  }
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
        result.eligible = result.evidence.eligibleAll;
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
