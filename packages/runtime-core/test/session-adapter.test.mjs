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

test("PremiseSession exposes a guardedWrite golden path and blocks a changed source", async () => {
  let version = "v1";
  const adapter = {
    capabilities: () => ({ contract: "premise-adapter/2", adapterId: "golden-path", features: ["OBSERVE", "REVALIDATE", "CONDITIONAL_ACTION"] }),
    observe: async ({ tenantId, resource }) => ({ tenantId, resource, value: { version }, version: { scheme: "test", token: version }, observedAt: at, evidence: evidence(resource, version) }),
    revalidate: async ({ evidence: currentEvidence }) => ({
      result: currentEvidence.version?.token === version ? "UNCHANGED" : "CHANGED",
      checkedAt: at,
      version: { scheme: "test", token: version }
    }),
    conditionalAction: async ({ expectedVersion, action }) => expectedVersion.token === version
      ? { accepted: true, result: action }
      : { accepted: false, reason: "VERSION_MISMATCH", observedVersion: { scheme: "test", token: version } }
  };

  const session = premise.session({ tenant: "tenant:session", adapter });
  const prepared = await session.prepareAction({ source: "source://item", action: { type: "publish" } });
  version = "v2";

  assert.deepEqual(await prepared.commitIfFresh(), {
    status: "blocked",
    code: "STALE_SOURCE",
    message: "The source changed before the conditional action was accepted.",
    memoryId: prepared.premise.memoryId,
    expectedVersion: "v1",
    observedVersion: "v2",
    retryable: true
  });
});

test("PremiseSession guardedWrite refuses an adapter without atomic action", async () => {
  const adapter = {
    capabilities: () => ({ contract: "premise-adapter/2", adapterId: "read-only", features: ["OBSERVE", "REVALIDATE"] }),
    observe: async ({ tenantId, resource }) => ({ tenantId, resource, value: {}, version: { scheme: "test", token: "v1" }, observedAt: at, evidence: evidence(resource) }),
    revalidate: async ({ evidence: currentEvidence }) => ({ result: "UNCHANGED", checkedAt: at, version: currentEvidence.version })
  };
  const result = await premise.session({ tenant: "tenant:session", adapter }).guardedWrite({ source: "source://item", action: "publish" });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "ACTION_NOT_ATOMIC");
  assert.equal(result.retryable, false);
});

test("PremiseSession guardedWrite returns a committed result for a fresh source", async () => {
  const adapter = {
    capabilities: () => ({ contract: "premise-adapter/2", adapterId: "write-capable", features: ["OBSERVE", "REVALIDATE", "CONDITIONAL_ACTION"] }),
    observe: async ({ tenantId, resource }) => ({ tenantId, resource, value: { ready: true }, version: { scheme: "test", token: "v1" }, observedAt: at, evidence: evidence(resource) }),
    revalidate: async ({ evidence: currentEvidence }) => ({ result: "UNCHANGED", checkedAt: at, version: currentEvidence.version }),
    conditionalAction: async ({ action }) => ({ accepted: true, result: { acceptedAction: action } })
  };

  const result = await premise.session({ tenant: "tenant:session", adapter }).guardedWrite({ source: "source://item", action: { type: "publish" } });
  assert.equal(result.status, "committed");
  assert.match(result.memoryId, /^session:observation:/);
  assert.equal(result.expectedVersion, "v1");
  assert.deepEqual(result.result, { acceptedAction: { type: "publish" } });
});
