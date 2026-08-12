import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compactManifestPath = resolve(root, "spec/premise-1/vectors/manifest.json");
const wireManifestPath = resolve(root, "spec/premise-1/test-vectors/manifest.json");
const evolutionManifests = [
  { profile: "premise/1.1", path: resolve(root, "spec/premise-1.1/vectors/manifest.json") },
  { profile: "premise-guard/1", path: resolve(root, "spec/premise-guard-1/vectors/manifest.json") },
  { profile: "premise-policy/1", path: resolve(root, "spec/premise-policy-1/vectors/manifest.json") }
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }

function parseOutput(stdout, label) {
  try { return JSON.parse(stdout.trim()); }
  catch (error) { throw new Error(`${label} did not return JSON: ${error.message}\n${stdout}`); }
}

async function pythonCommand(args, label) {
  const candidates = process.env.PREMISE_PYTHON ? [process.env.PREMISE_PYTHON] : process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  let lastError;
  for (const candidate of candidates) {
    try {
      const actualArgs = candidate === "py" ? ["-3", ...args] : args;
      const { stdout } = await exec(candidate, actualArgs, { cwd: root, maxBuffer: 4 * 1024 * 1024 });
      return parseOutput(stdout, label);
    } catch (error) { lastError = error; }
  }
  throw new Error(`No usable Python interpreter found: ${lastError?.message ?? "unknown error"}`);
}

let typescriptBuilt = false;
async function buildReferenceTypescript() {
  if (typescriptBuilt) return;
  await exec(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "reference/typescript/tsconfig.json", "--pretty", "false"], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  typescriptBuilt = true;
}

async function runTypescript(manifestPath) {
  await buildReferenceTypescript();
  const { stdout } = await exec(process.execPath, ["reference/typescript/cli.mjs", manifestPath], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  return parseOutput(stdout, "TypeScript premise/1 reference");
}

async function runPythonCompact(manifestPath) {
  return pythonCommand(["reference/python/cli-premise1.py", manifestPath], "Python premise/1 reference");
}

async function runEvolutionTypescript(manifestPath) {
  await buildReferenceTypescript();
  const { stdout } = await exec(process.execPath, ["reference/typescript/dist/cli-evolution.js", manifestPath], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  return parseOutput(stdout, "TypeScript evolution reference");
}

async function runEvolutionPython(manifestPath) {
  return pythonCommand(["reference/python/cli-evolution.py", manifestPath], "Python evolution reference");
}

function assertEqual(left, right, label) {
  if (JSON.stringify(canonical(left)) !== JSON.stringify(canonical(right))) {
    throw new Error(`${label}\nleft: ${JSON.stringify(left)}\nright: ${JSON.stringify(right)}`);
  }
}

async function runCompact() {
  const manifest = await readJson(compactManifestPath);
  const vectors = await Promise.all(manifest.vectors.map((name) => readJson(resolve(dirname(compactManifestPath), name))));
  const [typescript, python] = await Promise.all([runTypescript(compactManifestPath), runPythonCompact(compactManifestPath)]);
  assertEqual(typescript, python, "Compact TypeScript/Python mismatch");
  const expectedById = new Map(vectors.map((vector) => [vector.id, vector.expected]));
  for (const row of typescript) {
    const vector = vectors.find((candidate) => candidate.id === row.id);
    const expected = vector?.operation === "revalidate" ? vector.results.map((item) => item.expected) : expectedById.get(row.id);
    assertEqual(row.output, expected, `Unexpected compact output for ${row.id}`);
  }
  if (typescript.length !== vectors.length) throw new Error(`Compact result count mismatch: ${typescript.length} != ${vectors.length}`);
  console.log(`PREMiSE/1 conformance: PASS (${vectors.length} vectors; TypeScript == Python == expected)`);
  for (const vector of vectors) console.log(`✓ ${vector.id}`);
}

async function runWire() {
  const manifest = await readJson(wireManifestPath);
  const records = await Promise.all(manifest.vectors.map(async (entry) => ({
    entry,
    vector: await readJson(resolve(dirname(wireManifestPath), entry.file))
  })));
  await exec(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "packages/conformance/tsconfig.json", "--pretty", "false"], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  const module = await import(pathToFileURL(resolve(root, "packages/conformance/dist/vectors.js")).href);
  const executionManifest = {
    format: "premise-test-vector-manifest/0.1",
    protocol: "premise/0.1",
    files: records.map(({ entry }) => ({ path: entry.file, vectorIds: [entry.id] }))
  };
  const suites = Object.fromEntries(records.map(({ entry, vector }) => [entry.file, {
    format: "premise-test-vector-suite/0.1",
    protocol: "premise/0.1",
    suiteId: entry.id,
    vectors: [{ ...vector, format: "premise-test-vector/0.1", protocol: "premise/0.1" }]
  }]));
  const report = module.executeTestVectors(executionManifest, suites);
  if (!report.valid) throw new Error(`Wire vectors failed:\n${report.failures.join("\n")}`);
  console.log(`PREMiSE/1 wire conformance: PASS (${records.length} vectors; executable state-machine reference)`);
  for (const { entry } of records) console.log(`✓ wire/${entry.id}`);
}

async function runEvolution({ profile, path }) {
  const manifest = await readJson(path);
  const vectors = await Promise.all(manifest.vectors.map((name) => readJson(resolve(dirname(path), name))));
  const [typescript, python] = await Promise.all([runEvolutionTypescript(path), runEvolutionPython(path)]);
  assertEqual(typescript, python, `${profile} TypeScript/Python mismatch`);
  const expectedById = new Map(vectors.map((vector) => [vector.id, vector.expected]));
  for (const row of typescript) assertEqual(row.output, expectedById.get(row.id), `Unexpected ${profile} output for ${row.id}`);
  if (typescript.length !== vectors.length) throw new Error(`${profile} result count mismatch`);
  console.log(`PREMiSE ${profile} conformance: PASS (${vectors.length} vectors; TypeScript == Python == expected)`);
  for (const vector of vectors) console.log(`✓ ${profile}/${vector.id}`);
}

await runCompact();
await runWire();
for (const manifest of evolutionManifests) await runEvolution(manifest);
