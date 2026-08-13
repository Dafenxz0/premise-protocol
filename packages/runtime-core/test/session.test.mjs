import test from "node:test";
import assert from "node:assert/strict";
import { PremiseSession, PremiseRuntime, premise } from "../dist/index.js";

const at = "2026-08-14T00:00:00Z";
const envelope = (memoryId, status = "FRESH", dependsOn = [], source = "source://repo", token = "v1", tenantId = "tenant:session") => ({
  specVersion: "premise/2",
  tenantId,
  memoryId,
  contentDigest: `sha256:${memoryId.padEnd(64, "a").slice(0, 64)}`,
  evidence: [{ evidenceId: `evidence:${memoryId}`, sourceUri: source, version: { scheme: "test", token }, validator: { id: "test", operation: "read" }, observedAt: at }],
  confidence: { score: null, method: "test", assessedAt: at },
  conflicts: [],
  temporal: { asOf: at },
  dependsOn,
  signatures: [],
  validity: { status, policy: "VERSIONED", checkedAt: at }
});

function adapter() {
  return {
    observe: (resource) => ({ envelope: envelope(`memory:${resource.replaceAll("/", ":")}`), content: { resource } }),
    derive: ({ from }) => ({ envelope: envelope("memory:claim", "FRESH", from.map((item) => item.memoryId)), content: { claim: "ready" } }),
    revalidate: async (evidence, record) => ({ memoryId: record.envelope.memoryId, result: "UNCHANGED", status: "FRESH", checkedAt: at, sourceUri: evidence.sourceUri, version: evidence.version }),
    conditionalAction: ({ expectedVersion }) => ({ accepted: expectedVersion === "v1", result: "merged" })
  };
}

test("session exposes observe, derive, check and guarded act without leaking runtime plumbing", async () => {
  const session = premise.session({ tenant: "tenant:session", adapter: adapter() });
  const observed = await session.observe("github://repo/pr/42");
  assert.equal(session.check(observed).decision, "USABLE");
  const claim = await session.derive({ claim: "PR is ready", from: [observed] });
  assert.equal(session.check(claim).decision, "USABLE");
  assert.deepEqual(await session.act({ premise: claim, action: "merge" }), {
    accepted: true,
    memoryId: "memory:claim",
    expectedVersion: "v1",
    result: "merged"
  });
});

test("session rejects cross-tenant records and refuses unguarded actions", async () => {
  const foreign = new PremiseSession({ tenant: "tenant:session", adapter: { ...adapter(), observe: () => ({ envelope: envelope("memory:x", "FRESH", [], "source://repo", "v1", "tenant:other"), content: {} }) } });
  await assert.rejects(() => foreign.observe("repo"), /session tenant/);
  const safe = new PremiseSession({ tenant: "tenant:session", adapter: { ...adapter(), conditionalAction: undefined } });
  const observed = await safe.observe("repo");
  await assert.rejects(() => safe.act({ premise: observed, action: "merge" }), /conditionalAction/);
});

test("session can use a caller-owned runtime when tenants match", () => {
  const runtime = new PremiseRuntime({ tenantId: "tenant:session", now: () => at });
  assert.ok(premise.session({ tenant: "tenant:session", adapter: adapter(), runtime }) instanceof PremiseSession);
});
