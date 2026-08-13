import test from "node:test";
import assert from "node:assert/strict";
import { createExplanationDocument } from "../dist/explainability.js";

const at = "2026-08-14T00:00:00Z";

test("redacts payloads and keeps only auditable metadata", () => {
  const document = createExplanationDocument({
    tenantId: "tenant:alpha",
    memoryId: "memory:deploy",
    decision: "USE",
    state: "FRESH",
    policy: "VERSIONED",
    risk: "HIGH",
    evidence: [{
      evidenceId: "evidence:deploy",
      version: { scheme: "git", token: "commit-a" },
      observedAt: at,
      payload: "private source contents"
    }],
    receipt: { payload: { secret: "must not appear" }, reasonCodes: ["RECEIPT_VALID"] }
  });

  assert.equal(document.redaction, "PAYLOADS_OMITTED");
  assert.equal(document.evidence[0].evidenceId, "evidence:deploy");
  assert.deepEqual(document.evidence[0].version, { scheme: "git", token: "commit-a" });
  assert.equal(JSON.stringify(document).includes("private source contents"), false);
  assert.equal(JSON.stringify(document).includes("must not appear"), false);
  assert.equal("payload" in document, false);
});

test("ordering is deterministic regardless of input order", () => {
  const first = createExplanationDocument({
    tenantId: "tenant:alpha",
    memoryId: "memory:claim",
    decision: "REVALIDATE",
    state: "STALE",
    reasonCodes: ["Z_REASON", "A_REASON"],
    dependsOn: ["memory:b", "memory:a"],
    evidence: [
      { evidenceId: "evidence:z", version: { scheme: "git", token: "z" } },
      { evidenceId: "evidence:a", version: { scheme: "git", token: "a" } }
    ],
    dependencies: [
      { memoryId: "memory:b", state: "FRESH" },
      { memoryId: "memory:a", state: "STALE", reasonCodes: ["SOURCE_CHANGED"] }
    ]
  });
  const second = createExplanationDocument({
    tenantId: "tenant:alpha",
    memoryId: "memory:claim",
    decision: "REVALIDATE",
    state: "STALE",
    reasonCodes: ["A_REASON", "Z_REASON"],
    dependsOn: ["memory:a", "memory:b"],
    evidence: [
      { evidenceId: "evidence:a", version: { scheme: "git", token: "a" } },
      { evidenceId: "evidence:z", version: { scheme: "git", token: "z" } }
    ],
    dependencies: [
      { memoryId: "memory:a", state: "STALE", reasonCodes: ["SOURCE_CHANGED"] },
      { memoryId: "memory:b", state: "FRESH" }
    ]
  });

  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test("tenant scope rejects foreign evidence and dependencies", () => {
  assert.throws(() => createExplanationDocument({
    tenantId: "tenant:alpha",
    decision: "REJECT",
    state: "INVALID",
    evidence: [{ evidenceId: "evidence:foreign", tenantId: "tenant:beta" }]
  }), /tenant scope/);
  assert.throws(() => createExplanationDocument({
    tenantId: "tenant:alpha",
    decision: "REJECT",
    state: "INVALID",
    dependencies: [{ memoryId: "memory:foreign", tenantId: "tenant:beta", state: "INVALID" }]
  }), /tenant scope/);
  assert.throws(() => createExplanationDocument({
    tenantId: "tenant:alpha",
    decision: "REJECT",
    state: "INVALID",
    receipt: { tenantId: "tenant:beta" }
  }), /tenant scope/);
});

test("dependency cascade is represented as sorted causal edges", () => {
  const document = createExplanationDocument({
    tenantId: "tenant:alpha",
    memoryId: "memory:release",
    decision: "REJECT",
    state: "INVALID",
    reasonCodes: ["INCOMPATIBLE_GATE"],
    dependsOn: ["memory:service", "memory:config"],
    dependencies: [
      { memoryId: "memory:service", state: "INVALID", dependsOn: ["memory:database"] },
      { memoryId: "memory:config", state: "STALE" }
    ]
  });

  assert.deepEqual(document.causalDependencies, [
    { from: "memory:config", to: "memory:release", relation: "DEPENDS_ON" },
    { from: "memory:database", to: "memory:service", relation: "DEPENDS_ON" },
    { from: "memory:service", to: "memory:release", relation: "DEPENDS_ON" }
  ]);
  assert.deepEqual(document.reasonCodes, ["DEPENDENCY_INVALID", "DEPENDENCY_STALE", "INCOMPATIBLE_GATE"]);
});

test("UNKNOWN remains explicit and is never upgraded by explanation", () => {
  const document = createExplanationDocument({
    tenantId: "tenant:alpha",
    decision: "REVALIDATE",
    state: "UNKNOWN",
    receipt: {
      reason: "UNKNOWN_EVIDENCE",
      evidence: [{ evidenceId: "evidence:missing" }]
    }
  });

  assert.equal(document.state, "UNKNOWN");
  assert.equal(document.decision, "REVALIDATE");
  assert.deepEqual(document.reasonCodes, ["STATE_UNKNOWN", "UNKNOWN_EVIDENCE"]);
  assert.equal(document.evidence[0].version, undefined);
});
