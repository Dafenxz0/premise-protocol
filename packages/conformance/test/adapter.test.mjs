import assert from "node:assert/strict";
import { runAdapterConformance } from "../dist/index.js";

const adapter = {
  capabilities: () => ({ contract: "premise-adapter/2", adapterId: "fixture", features: ["OBSERVE", "REVALIDATE", "CONDITIONAL_ACTION"] }),
  observe: async ({ tenantId, resource }) => ({ tenantId, resource, value: { resource }, version: { scheme: "fixture", token: "v1" }, observedAt: "2026-08-14T00:00:00Z", evidence: [{ evidenceId: "e1", sourceUri: resource, observedAt: "2026-08-14T00:00:00Z", version: { scheme: "fixture", token: "v1" }, validator: { id: "fixture", operation: "read" } }] }),
  revalidate: async () => ({ result: "UNCHANGED", checkedAt: "2026-08-14T00:00:00Z" }),
  conditionalAction: async () => ({ accepted: true })
};

const report = await runAdapterConformance(adapter, { tenantId: "tenant:test", resource: "fixture://item/1", expectConditionalAction: true });
assert.equal(report.passed, true, JSON.stringify(report));
assert.deepEqual(report.results.map((result) => result.id), ["capabilities", "initial-observation", "revalidation", "conditional-action"]);
const failed = await runAdapterConformance({ ...adapter, observe: async () => ({ ...await adapter.observe({ tenantId: "tenant:test", resource: "fixture://item/1" }), tenantId: "tenant:other" }) }, { tenantId: "tenant:test", resource: "fixture://item/1" });
assert.equal(failed.passed, false);
console.log("adapter conformance tests passed");
