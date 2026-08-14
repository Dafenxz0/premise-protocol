import assert from "node:assert/strict";
import { premise } from "../packages/runtime-core/dist/index.js";

const observedAt = "2026-08-14T00:00:00.000Z";
const tenantId = "tenant:quickstart";

function record(memoryId, content, dependsOn = []) {
  const sourceUri = `quickstart://${memoryId}`;
  const version = { scheme: "quickstart", token: "v1" };
  return {
    envelope: {
      specVersion: "premise/2",
      tenantId,
      memoryId,
      contentDigest: `sha256:${memoryId.padEnd(64, "0").slice(0, 64)}`,
      evidence: [{
        evidenceId: `evidence:${memoryId}`,
        sourceUri,
        version,
        validator: { id: "quickstart", operation: "read" },
        observedAt
      }],
      confidence: { score: null, method: "quickstart", assessedAt: observedAt },
      conflicts: [],
      temporal: { asOf: observedAt },
      dependsOn,
      signatures: [],
      validity: { status: "FRESH", policy: "VERSIONED", checkedAt: observedAt }
    },
    content
  };
}

const adapter = {
  observe(resource) {
    return record(`source:${resource}`, { resource, status: "ready" });
  },
  derive({ claim, from }) {
    return record("claim:ready", { claim }, from.map((premise) => premise.memoryId));
  },
  revalidate(evidence, current) {
    return {
      memoryId: current.envelope.memoryId,
      sourceUri: evidence.sourceUri,
      result: "UNCHANGED",
      status: "FRESH",
      checkedAt: observedAt,
      version: evidence.version
    };
  },
  conditionalAction({ expectedVersion }) {
    return { accepted: expectedVersion.token === "v1", result: "action-committed" };
  }
};

const session = premise.session({ tenant: tenantId, adapter });
const source = await session.observe("config");
const plan = await session.derive({ claim: "The config is ready to use", from: [source] });

assert.equal(session.check(plan).decision, "USABLE");
const committed = await session.act({ premise: plan, action: { type: "publish" } });
assert.equal(committed.accepted, true);

console.log(JSON.stringify({ decision: "USABLE", action: committed.result }));
