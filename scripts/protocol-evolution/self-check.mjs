import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const profiles = [
  { directory: "spec/premise-1.1", manifest: "vectors/manifest.json", vectorDirectory: "vectors", entriesField: "vectors", entryFileField: "file", idField: "id" },
  { directory: "spec/premise-1.1", manifest: "test-vectors/manifest.json", vectorDirectory: "test-vectors", entriesField: "files", entryFileField: "path", idField: "vectorId", rich: true },
  { directory: "spec/premise-guard-1", manifest: "vectors/manifest.json", vectorDirectory: "vectors", entriesField: "vectors", entryFileField: "file", idField: "vectorId", rich: true },
  { directory: "spec/premise-policy-1", manifest: "vectors/manifest.json", vectorDirectory: "vectors", entriesField: "vectors", entryFileField: "file", idField: "id" },
  { directory: "spec/premise-policy-1", manifest: "vectors/supplemental-manifest.json", vectorDirectory: "vectors", entriesField: "vectors", entryFileField: "file", idField: "id" }
];

function assert(condition, message) { if (!condition) throw new Error(message); }

for (const profile of profiles) {
  const manifestPath = join(root, profile.directory, profile.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entries = manifest[profile.entriesField];
  assert(Array.isArray(entries) && entries.length > 0, `${profile.directory}/${profile.manifest}: empty vectors`);
  const ids = new Set();
  for (const entry of entries) {
    const file = typeof entry === "string" ? entry : entry[profile.entryFileField];
    const vector = JSON.parse(await readFile(join(root, profile.directory, profile.vectorDirectory, file), "utf8"));
    const id = vector[profile.idField] ?? vector.id ?? vector.vectorId;
    assert(typeof id === "string" && id.length > 0, `${file}: missing stable id`);
    assert(!ids.has(id), `${profile.directory}: duplicate vector ${id}`);
    ids.add(id);
    if (profile.rich) assert(Array.isArray(vector.steps) && vector.steps.length > 0, `${file}: rich vector has no steps`);
    else assert(vector.expected !== undefined || vector.operation === "guardedWrite", `${file}: missing authored expected output`);
  }
}

const closedCore = await readFile(join(root, "spec/premise-1/contract.schema.json"), "utf8");
assert(!closedCore.includes('"premise/1.1"'), "premise/1 schema must remain closed");
assert(!closedCore.includes("premise-policy-1"), "premise/1 schema must not import policy");
assert(!closedCore.includes("premise-guard-1"), "premise/1 schema must not import guard");

const referenceFiles = await readdir(join(root, "reference/typescript/src"));
assert(referenceFiles.includes("evolution.ts") && referenceFiles.includes("cli-evolution.ts"), "TypeScript evolution reference is incomplete");
const pythonFiles = await readdir(join(root, "reference/python"));
assert(pythonFiles.includes("evolution.py") && pythonFiles.includes("cli-evolution.py"), "Python evolution reference is incomplete");

console.log("PREMiSE protocol evolution self-check: PASS");
