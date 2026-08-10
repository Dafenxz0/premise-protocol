import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const strict = process.argv.includes("--strict");
const manifestPath = resolve(root, "spec/ga/acceptance.json");
const requiredDirectories = [
  "packages/security-core",
  "packages/connector-webhook",
  "packages/sdk",
  "benchmarks/ga-evaluation",
  "benchmarks/ga-load",
  "ops",
  "deploy"
];

async function exists(relativePath) {
  try {
    await access(resolve(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(`GA gate: ${message}`);
  process.exitCode = 1;
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.schemaVersion !== "premise/ga-1" || manifest.release !== "2.0.0") fail("invalid acceptance manifest version");
if (manifest.truthPolicy?.fixturesAreNotExternalEvidence !== true) fail("truth policy must reject fixture-only claims");
if (!Array.isArray(manifest.gates) || manifest.gates.length < 7) fail("acceptance manifest must contain all GA gates");

const ids = new Set();
for (const gate of manifest.gates ?? []) {
  if (typeof gate.id !== "string" || ids.has(gate.id)) fail(`gate id is missing or duplicated: ${gate.id ?? "unknown"}`);
  ids.add(gate.id);
  if (!Array.isArray(gate.evidence) || gate.evidence.length === 0) fail(`gate ${gate.id} has no evidence requirements`);
}

const missingDirectories = [];
for (const directory of requiredDirectories) if (!(await exists(directory))) missingDirectories.push(directory);
if (missingDirectories.length > 0) {
  fail(`GA implementation modules are missing: ${missingDirectories.join(", ")}`);
}

const evidenceRoot = process.env.PREMISE_GA_EVIDENCE_DIR;
if (strict && !evidenceRoot) fail("--strict requires PREMISE_GA_EVIDENCE_DIR");
if (strict && evidenceRoot) {
  const requiredEvidence = [...new Set(manifest.gates.flatMap((gate) => gate.evidence))];
  try {
    const available = new Set(await readdir(resolve(evidenceRoot)));
    const missingEvidence = requiredEvidence.filter((file) => !available.has(file));
    if (missingEvidence.length > 0) fail(`strict evidence is incomplete: ${missingEvidence.join(", ")}`);
  } catch {
    fail(`strict evidence directory does not exist or is not readable: ${evidenceRoot}`);
  }
}

if (process.exitCode !== 1) {
  console.log(JSON.stringify({
    gate: "PREMiSE v2.0 GA",
    status: strict ? "evidence-checked" : "implementation-checked",
    strict,
    gates: manifest.gates.map((gate) => gate.id),
    thresholds: manifest.thresholds
  }, null, 2));
}
