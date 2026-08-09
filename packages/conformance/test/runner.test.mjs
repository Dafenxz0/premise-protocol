import assert from "node:assert/strict";
import { assertConformanceCapabilities, missingRequiredCapabilities, runConformance } from "../dist/index.js";

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
console.log("conformance runner tests passed");
