import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(root, "spec/premise-1/vectors/manifest.json");

function command(name) {
  return process.platform === "win32" && name === "pnpm" ? "pnpm.cmd" : name;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function parseOutput(stdout, label) {
  try {
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}\n${stdout}`);
  }
}

async function runPython() {
  const candidates = process.env.PREMISE_PYTHON ? [process.env.PREMISE_PYTHON] : process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  let lastError;
  for (const candidate of candidates) {
    try {
      const args = candidate === "py" ? ["-3", "reference/python/cli-premise1.py", "spec/premise-1/vectors/manifest.json"] : ["reference/python/cli-premise1.py", "spec/premise-1/vectors/manifest.json"];
      const { stdout } = await exec(candidate, args, { cwd: root, maxBuffer: 1024 * 1024 });
      return parseOutput(stdout, "Python reference");
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`No usable Python interpreter found: ${lastError?.message ?? "unknown error"}`);
}

async function runTypescript() {
  await exec(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "reference/typescript/tsconfig.json", "--pretty", "false"], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  const { stdout } = await exec(process.execPath, ["reference/typescript/cli.mjs", "spec/premise-1/vectors/manifest.json"], { cwd: root, maxBuffer: 1024 * 1024 });
  return parseOutput(stdout, "TypeScript reference");
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const vectors = await Promise.all(manifest.vectors.map(async (name) => JSON.parse(await readFile(resolve(dirname(manifestPath), name), "utf8"))));
const [typescript, python] = await Promise.all([runTypescript(), runPython()]);
if (JSON.stringify(canonical(typescript)) !== JSON.stringify(canonical(python))) {
  throw new Error(`Cross-language mismatch\nTypeScript: ${JSON.stringify(typescript)}\nPython: ${JSON.stringify(python)}`);
}

const expectedById = new Map(vectors.map((vector) => [vector.id, vector.expected]));
for (const row of typescript) {
  const expected = expectedById.get(row.id);
  const vector = vectors.find((candidate) => candidate.id === row.id);
  if (vector?.operation === "revalidate") {
    const expectedRows = vector?.results?.map((item) => item.expected);
    if (JSON.stringify(canonical(row.output)) !== JSON.stringify(canonical(expectedRows))) throw new Error(`Unexpected output for ${row.id}`);
  } else if (JSON.stringify(canonical(row.output)) !== JSON.stringify(canonical(expected))) {
    throw new Error(`Unexpected output for ${row.id}: ${JSON.stringify(row.output)} != ${JSON.stringify(expected)}`);
  }
}

console.log(`PREMiSE/1 conformance: PASS (${vectors.length} vectors; TypeScript == Python == expected)`);
for (const vector of vectors) console.log(`✓ ${vector.id}`);
