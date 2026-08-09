import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { executeTestVectors, validateTestVectors, type VectorManifest, type VectorSuite } from "./vectors.js";

declare const console: { log(...values: readonly unknown[]): void };
declare const process: { cwd(): string; exitCode?: number };

const repositoryRoot = process.cwd().endsWith("packages\\conformance") || process.cwd().endsWith("packages/conformance")
  ? join(process.cwd(), "..", "..")
  : process.cwd();
const vectorDirectory = join(repositoryRoot, "spec", "test-vectors");
const manifest = JSON.parse(await readFile(join(vectorDirectory, "manifest.json"), "utf8")) as VectorManifest;
const suites = Object.fromEntries(await Promise.all(manifest.files.map(async (entry) => {
  const suite = JSON.parse(await readFile(join(vectorDirectory, entry.path), "utf8")) as VectorSuite;
  return [entry.path, suite] as const;
})));
const validation = validateTestVectors(manifest, suites);
const execution = validation.valid ? executeTestVectors(manifest, suites) : { valid: false, vectorCount: validation.vectorCount, passedCount: 0, failedCount: validation.vectorCount, failures: ["Structural vector validation failed"] };
const report = {
  format: "premise-conformance-report/0.1" as const,
  passed: validation.valid && execution.valid,
  total: validation.vectorCount,
  passedCount: execution.passedCount,
  failedCount: execution.failedCount,
  vectorValidation: validation,
  execution
};
console.log(JSON.stringify(report, null, 2));
if (!validation.valid || !execution.valid) process.exitCode = 1;
