import assert from "node:assert/strict";
import test from "node:test";
import { executePremiseGuard, PremiseSingleFlight, negotiatePremisePolicyCapabilities, premiseLeaseUsable } from "../dist/index.js";

test("guard fails closed without conditional commit capability", async () => {
  const result = await executePremiseGuard(
    { actionDigest: "sha256:action", criticalPremises: ["p1"], requiredCapability: "CAS", idempotencyKey: "op-1" },
    [{ premiseId: "p1", state: "FRESH", valid: true, identityKey: "a", versionToken: "v1" }],
    { capabilities: ["VERSION_TOKEN"], commit: () => ({ accepted: true }) }
  );
  assert.deepEqual(result, { accepted: false, decision: "UNSUPPORTED", reason: "MISSING_CONDITIONAL_COMMIT" });
});

test("guard maps an atomic version conflict to revalidation", async () => {
  const result = await executePremiseGuard(
    { actionDigest: "sha256:action", criticalPremises: ["p1"], requiredCapability: "CAS", idempotencyKey: "op-1" },
    [{ premiseId: "p1", state: "FRESH", valid: true, identityKey: "a", versionToken: "v1" }],
    { capabilities: ["CAS", "IDEMPOTENCY_KEY"], commit: () => ({ accepted: false, reason: "VERSION_MISMATCH", observedVersion: "v2" }) }
  );
  assert.deepEqual(result, { accepted: false, decision: "REVALIDATE", reason: "VERSION_MISMATCH", observedVersion: "v2" });
});

test("policy capability negotiation and single-flight preserve physical work counts", async () => {
  assert.deepEqual(negotiatePremisePolicyCapabilities(["CAS", "SCOPED_READ"], ["SCOPED_READ"]), { supported: ["SCOPED_READ"], unsupported: ["CAS"], decision: "UNSUPPORTED" });
  const flight = new PremiseSingleFlight();
  let calls = 0;
  const task = () => { calls += 1; return "receipt"; };
  const values = await Promise.all([flight.run("same-scope", task), flight.run("same-scope", task)]);
  assert.deepEqual(values, ["receipt", "receipt"]);
  assert.equal(calls, 1);
});

test("lease usability enforces expiry and fencing token", () => {
  const lease = { leaseId: "lease-1", fencingToken: "fence-2", expiresAt: "2026-08-12T19:00:00Z" };
  assert.equal(premiseLeaseUsable(lease, "2026-08-12T18:59:00Z", "fence-2"), true);
  assert.equal(premiseLeaseUsable(lease, "2026-08-12T18:59:00Z", "fence-1"), false);
  assert.equal(premiseLeaseUsable(lease, "2026-08-12T19:00:00Z", "fence-2"), false);
});
