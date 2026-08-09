import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertConformanceCapabilities, missingRequiredCapabilities, runConformance, validateTestVectors } from "../dist/index.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envelope = { specVersion: "premise/0.1", memoryId: "memory:test", provenance: [{ sourceUri: "memory://test", observedAt: "2026-08-09T19:20:00Z" }], validity: { status: "FRESH", checkedAt: "2026-08-09T19:20:00Z", policy: "IMMUTABLE" }, dependsOn: [] };
const adapter = {
  capabilities: { specVersion: "premise/0.1", capabilities: ["RECORD", "DEPENDENCY", "REVALIDATION"] },
  async register() {},
  async derive() {},
  async signal() { return { accepted: true }; },
  async validate() { return []; },
  async check() { return [{ memoryId: "memory:test", decision: "USABLE" }]; },
  async history() { return []; }
};

assert.deepEqual(missingRequiredCapabilities(["RECORD"]), ["DEPENDENCY", "REVALIDATION"]);
assert.doesNotThrow(() => assertConformanceCapabilities(adapter));
const report = await runConformance(adapter, [{ id: "basic", steps: [{ id: "register", operation: "register", input: envelope }, { id: "check", operation: "check", input: ["memory:test"], expect: [{ memoryId: "memory:test", decision: "USABLE" }] }] }]);
assert.equal(report.passed, true);
assert.equal(report.failedCount, 0);
const vectorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../spec/test-vectors");
const manifest = JSON.parse(await readFile(path.join(vectorDir, "manifest.json"), "utf8"));
const suites = Object.fromEntries(await Promise.all(manifest.files.map(async (entry) => [entry.path, JSON.parse(await readFile(path.join(vectorDir, entry.path), "utf8"))])));
const vectors = validateTestVectors(manifest, suites);
assert.equal(vectors.valid, true, vectors.errors.join("; "));
assert.equal(vectors.vectorCount, 16);
console.log("conformance runner tests passed");
