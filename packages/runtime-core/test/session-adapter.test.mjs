import test from "node:test";
import assert from "node:assert/strict";
import { PremiseSession, premise } from "../dist/index.js";

const at = "2026-08-14T00:00:00Z";

function evidence(resource, token = "v1") {
  return [{
    evidenceId: `evidence:${resource}`,
    sourceUri: resource,
    version: { scheme: "test", token },
    validator: { id: "test", operation: "read" },
    observedAt: at
  }];
}

function record(memoryId, content, dependsOn = [], resource = "source://item") {
  return {
    envelope: {
      specVersion: "premise/2",
      tenantId: "tenant:session",
      memoryId,
      contentDigest: `sha256:${memoryId.padEnd(64, "a").slice(0, 64)}`,
      evidence: evidence(resource),
      confidence: { score: null, method: "test", assessedAt: at },
      conflicts: [],
      temporal: { asOf: at },
      dependsOn,
      signatures: [],
      validity: { status: "FRESH", policy: "VERSIONED", checkedAt: at }
    },
    content
  };
}

test("PremiseSession consumes the SDK PremiseAdapter shape directly", async () => {
  const adapter = {
    capabilities: () => ({ contract: "premise-adapter/2", adapterId: "test-sdk", features: ["OBSERVE", "REVALIDATE", "CONDITIONAL_ACTION"] }),
    observe: async ({ tenantId, resource }) => ({ tenantId, resource, value: { resource }, version: { scheme: "test", token: "v1" }, observedAt: at, evidence: evidence(resource) }),
    revalidate: async ({ evidence: currentEvidence }) => ({ result: "UNCHANGED", checkedAt: at, version: currentEvidence.version }),
    conditionalAction: async ({ action, expectedVersion }) => ({ accepted: expectedVersion.token === "v1", result: action })
  };

  const session = premise.session({ tenant: "tenant:session", adapter });
  const observed = await session.observe("source://item");
  const claim = await session.derive({ claim: "item is ready", from: [observed] });

  assert.equal(session.check(claim).decision, "USABLE");
  assert.deepEqual(await session.act({ premise: claim, action: { type: "merge" } }), {
    accepted: true,
    memoryId: claim.memoryId,
    expectedVersion: "v1",
    result: { type: "merge" }
  });
});

test("PremiseSession keeps accepting legacy runtime-record adapters without derive", async () => {
  const adapter = {
    observe: async (resource) => record(`memory:${resource}`, { resource }, [], resource),
    revalidate: async (currentEvidence, currentRecord) => ({
      memoryId: currentRecord.envelope.memoryId,
      result: "UNCHANGED",
      status: "FRESH",
      checkedAt: at,
      sourceUri: currentEvidence.sourceUri,
      evidenceId: currentEvidence.evidenceId,
      version: currentEvidence.version
    }),
    conditionalAction: async ({ expectedVersion }) => ({ accepted: expectedVersion.token === "v1", result: "merged" })
  };

  const session = new PremiseSession({ tenant: "tenant:session", adapter });
  const observed = await session.observe("source://item");
  const claim = await session.derive({ claim: "item is ready", from: [observed] });

  assert.deepEqual(await session.act({ premise: claim, action: "merge" }), {
    accepted: true,
    memoryId: claim.memoryId,
    expectedVersion: "v1",
    result: "merged"
  });
});

test("PremiseSession rejects a non-callable capabilities marker", () => {
  const adapter = {
    capabilities: { contract: "premise-adapter/2" },
    observe: async () => record("memory:malformed", {}),
    revalidate: async () => ({ result: "UNKNOWN", checkedAt: at })
  };

  assert.throws(
    () => new PremiseSession({ tenant: "tenant:session", adapter }),
    /adapter\.capabilities must be a function/
  );
});
