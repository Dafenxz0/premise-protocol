import assert from "node:assert/strict";
import test from "node:test";
import { ContextEngine } from "../packages/context-engine/dist/index.js";
import { InMemoryRuntimeStore, PremiseRuntime } from "../packages/runtime-core/dist/index.js";

const at = "2026-08-11T10:00:00Z";

function envelope(memoryId, tenantId, token = "v1") {
  return {
    specVersion: "premise/2",
    tenantId,
    memoryId,
    evidence: [{
      evidenceId: `${memoryId}:e`,
      sourceUri: "source://shared",
      observedAt: at,
      version: { scheme: "revision", token },
      validator: { id: "test", operation: "read" }
    }],
    confidence: { score: null, method: "test", assessedAt: at },
    conflicts: [],
    temporal: { asOf: at },
    validity: { status: "FRESH", checkedAt: at, policy: "VERSIONED" },
    dependsOn: [],
    signatures: []
  };
}

test("revalidateMany and revalidate-and-act expose atomic stale-version rejection", async () => {
  const runtime = new PremiseRuntime({ tenantId: "tenant:a", now: () => at });
  runtime.register({ envelope: envelope("memory:a", "tenant:a"), content: { value: "safe" } });

  assert.equal(typeof runtime.revalidateMany, "function", "batch revalidation is required");
  assert.equal(typeof runtime.revalidateAndAct, "function", "atomic revalidate-and-act is required");

  const reports = await runtime.revalidateMany(["memory:a"], async (evidence) => ({
    memoryId: "memory:a",
    evidenceId: evidence.evidenceId,
    result: "UNCHANGED",
    status: "FRESH",
    checkedAt: at,
    version: { scheme: "revision", token: "v2" }
  }));
  assert.equal(reports[0].status, "FRESH");

  const action = await runtime.revalidateAndAct("memory:a", { expectedVersion: "v1", kind: "apply" });
  assert.equal(action.accepted, false);
  assert.equal(action.reason, "VERSION_MISMATCH");
});

test("revalidation and actions never cross tenant boundaries", () => {
  const store = new InMemoryRuntimeStore();
  store.put({ envelope: envelope("memory:shared", "tenant:a"), content: { tenant: "a" } });
  const runtime = new PremiseRuntime({ store, tenantId: "tenant:b", now: () => at });

  assert.equal(runtime.get("memory:shared"), undefined);
  assert.deepEqual(runtime.checkMany(["memory:shared"]), [{
    memoryId: "memory:shared",
    status: "INVALID",
    decision: "REJECT",
    reason: "missing or inaccessible memory"
  }]);
});

test("missing token counts are unknown, not zero", () => {
  let estimates = 0;
  const engine = new ContextEngine({ tokenEstimator: () => { estimates += 1; return 7; } });
  const result = engine.select({
    tokenBudget: 7,
    chunkSizeTokens: 7,
    candidates: [{ id: "missing-token-count", content: "unmeasured content" }]
  });

  assert.equal(estimates, 1, "a missing tokenCount must invoke the estimator");
  assert.equal(result.trace[0].tokens, 7, "missing tokenCount must not be coerced to zero");
  assert.equal(result.tokensUsed, 7);
});
