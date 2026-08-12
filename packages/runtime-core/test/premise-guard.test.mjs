import assert from "node:assert/strict";
import test from "node:test";
import { executePremiseGuard, planPremiseValidation, PremiseSingleFlight, negotiatePremisePolicyCapabilities, premiseLeaseUsable, premiseReceiptSharingKey, premiseReceiptSharingFrontierKey } from "../dist/index.js";

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

test("guard rejects duplicate receipts instead of silently selecting the last one", async () => {
  let commits = 0;
  const result = await executePremiseGuard(
    { actionDigest: "sha256:action", criticalPremises: ["p1"], requiredCapability: "CAS", idempotencyKey: "op-1" },
    [
      { premiseId: "p1", state: "FRESH", valid: true, identityKey: "a", versionToken: "v1" },
      { premiseId: "p1", state: "FRESH", valid: true, identityKey: "a", versionToken: "v2" }
    ],
    { capabilities: ["CAS", "IDEMPOTENCY_KEY"], commit: () => { commits += 1; return { accepted: true }; } }
  );
  assert.deepEqual(result, { accepted: false, decision: "REJECT", reason: "DUPLICATE_RECEIPT" });
  assert.equal(commits, 0);
});

test("guard rejects malformed runtime states and requires fenced lease support", async () => {
  let commits = 0;
  const malformed = await executePremiseGuard(
    { actionDigest: "sha256:action", criticalPremises: ["p1"], requiredCapability: "CAS", idempotencyKey: "op-state" },
    [{ premiseId: "p1", state: "CORRUPT", valid: true, identityKey: "a", versionToken: "v1" }],
    { capabilities: ["CAS", "IDEMPOTENCY_KEY"], commit: () => { commits += 1; return { accepted: true }; } }
  );
  assert.deepEqual(malformed, { accepted: false, decision: "REJECT", reason: "INVALID_RECEIPT" });

  const lease = await executePremiseGuard(
    { actionDigest: "sha256:action", criticalPremises: ["p1"], requiredCapability: "CAS", idempotencyKey: "op-lease", lease: { leaseId: "lease-1", fencingToken: "fence-1" } },
    [{ premiseId: "p1", state: "FRESH", valid: true, identityKey: "a", versionToken: "v1" }],
    { capabilities: ["CAS", "IDEMPOTENCY_KEY"], commit: () => { commits += 1; return { accepted: true }; } }
  );
  assert.deepEqual(lease, { accepted: false, decision: "UNSUPPORTED", reason: "MISSING_CONDITIONAL_COMMIT" });
  assert.equal(commits, 0);
});

test("atomic batch is additional scope and never a substitute for conditional commit", async () => {
  const intent = { actionDigest: "sha256:batch", criticalPremises: ["p1"], requiredCapability: "ATOMIC_BATCH", idempotencyKey: "op-batch" };
  const receipts = [{ premiseId: "p1", state: "FRESH", valid: true, identityKey: "a", versionToken: "v1" }];
  let commits = 0;
  const unsupported = await executePremiseGuard(intent, receipts, {
    capabilities: ["ATOMIC_BATCH", "IDEMPOTENCY_KEY"],
    commit: () => { commits += 1; return { accepted: true }; }
  });
  assert.deepEqual(unsupported, { accepted: false, decision: "UNSUPPORTED", reason: "MISSING_CONDITIONAL_COMMIT" });
  assert.equal(commits, 0);

  const allowed = await executePremiseGuard(intent, receipts, {
    capabilities: ["ATOMIC_BATCH", "CAS", "IDEMPOTENCY_KEY"],
    commit: () => { commits += 1; return { accepted: true, result: "applied" }; }
  });
  assert.deepEqual(allowed, { accepted: true, decision: "ALLOW", result: "applied" });
  assert.equal(commits, 1);
});

test("guard exposes only a complete atomic conflict observation for revalidation", async () => {
  const observedReceipts = [{ premiseId: "p1", state: "FRESH", valid: true, identityKey: "a", versionToken: "v2" }];
  const result = await executePremiseGuard(
    { actionDigest: "sha256:action", criticalPremises: ["p1"], requiredCapability: "CAS", idempotencyKey: "op-1" },
    [{ premiseId: "p1", state: "FRESH", valid: true, identityKey: "a", versionToken: "v1" }],
    { capabilities: ["CAS", "IDEMPOTENCY_KEY"], commit: () => ({ accepted: false, reason: "VERSION_MISMATCH", observedVersion: "v2", observedReceipts }) }
  );
  assert.deepEqual(result, { accepted: false, decision: "REVALIDATE", reason: "VERSION_MISMATCH", observedVersion: "v2", observedReceipts });

  const incomplete = await executePremiseGuard(
    { actionDigest: "sha256:action", criticalPremises: ["p1"], requiredCapability: "CAS", idempotencyKey: "op-2" },
    observedReceipts,
    { capabilities: ["CAS", "IDEMPOTENCY_KEY"], commit: () => ({ accepted: false, reason: "VERSION_MISMATCH", observedReceipts: [] }) }
  );
  assert.deepEqual(incomplete, { accepted: false, decision: "REVALIDATE", reason: "VERSION_MISMATCH" });

  const stale = await executePremiseGuard(
    { actionDigest: "sha256:action", criticalPremises: ["p1"], requiredCapability: "CAS", idempotencyKey: "op-3" },
    observedReceipts,
    { capabilities: ["CAS", "IDEMPOTENCY_KEY"], commit: () => ({ accepted: false, reason: "VERSION_MISMATCH", observedReceipts: [{ ...observedReceipts[0], state: "STALE" }] }) }
  );
  assert.deepEqual(stale, { accepted: false, decision: "REVALIDATE", reason: "VERSION_MISMATCH" });
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

test("sharing keys require exact query and change-set scope while canonicalizing set order", () => {
  const base = {
    tenantId: "tenant-a",
    resourceId: "resource-a",
    incarnationId: "incarnation-a",
    versionToken: "version-a",
    scopes: ["/head", "/status"],
    queryDigest: "sha256:query-a",
    validatorId: "validator-a",
    authorizationContextDigest: "sha256:auth-a",
    policyDigest: "sha256:policy-a",
    changeSetDigest: "sha256:change-a",
    causalFrontier: ["event-b", "event-a"]
  };
  const key = premiseReceiptSharingKey(base);
  assert.match(key, /^sha256:[0-9a-f]{64}$/);
  assert.equal(key, premiseReceiptSharingKey({ ...base, scopes: ["/status", "/head", "/head"], causalFrontier: ["event-a", "event-b", "event-a"] }));
  assert.notEqual(key, premiseReceiptSharingKey({ ...base, queryDigest: "sha256:query-b" }));
  assert.notEqual(key, premiseReceiptSharingKey({ ...base, changeSetDigest: "sha256:change-b" }));
  assert.throws(() => premiseReceiptSharingKey({ ...base, changeSetDigest: undefined }), /non-empty/);
  assert.notEqual(key, premiseReceiptSharingKey({ ...base, versionToken: "version-b" }));
  assert.throws(() => premiseReceiptSharingKey({ ...base, queryDigest: "" }), /non-empty/);
});

test("a complete multi-resource frontier shares one validation without dropping scope", async () => {
  const base = {
    tenantId: "tenant-a", incarnationId: "incarnation-a", scopes: ["/checkout"],
    queryDigest: "sha256:query-a", validatorId: "validator-a", authorizationContextDigest: "sha256:auth-a",
    policyDigest: "sha256:policy-a", changeSetDigest: "sha256:change-a", causalFrontier: ["event-a"]
  };
  const resources = [
    { ...base, resourceId: "config:eu", versionToken: "config-v2" },
    { ...base, resourceId: "artifact:us", versionToken: "artifact-v2" }
  ];
  const key = premiseReceiptSharingFrontierKey(resources);
  assert.equal(key, premiseReceiptSharingFrontierKey([...resources].reverse()));
  assert.notEqual(key, premiseReceiptSharingFrontierKey([{ ...resources[0], versionToken: "config-v3" }, resources[1]]));
  assert.notEqual(key, premiseReceiptSharingFrontierKey([{ ...resources[0], authorizationContextDigest: "sha256:auth-b" }, resources[1]]));
  const flight = new PremiseSingleFlight();
  let reads = 0;
  const task = () => { reads += 1; return "fresh-frontier"; };
  assert.deepEqual(await Promise.all([flight.runFrontier(resources, task), flight.runFrontier(resources, task)]), ["fresh-frontier", "fresh-frontier"]);
  assert.equal(reads, 1);
  assert.throws(() => premiseReceiptSharingFrontierKey([{ ...resources[0] }, { ...resources[0] }]), /duplicate resources/);
});

test("risk-aware planning is monotonic and never lets TTL authorize a risky write", () => {
  const versionedRead = {
    operation: "READ",
    state: "FRESH",
    sourceMode: "VERSIONED",
    hasVersionToken: true,
    capabilities: ["CONDITIONAL_READ", "CAUSAL_FRONTIER"],
    causalFrontierComplete: true
  };
  assert.deepEqual(planPremiseValidation({ ...versionedRead, risk: "LOW" }), {
    decision: "USE", validation: "NONE", guardRequired: false, reason: "LOW_RISK_FRESH_RECEIPT"
  });
  for (const risk of ["MEDIUM", "HIGH", "CRITICAL"]) {
    assert.deepEqual(planPremiseValidation({ ...versionedRead, risk }), {
      decision: "REVALIDATE", validation: "CONDITIONAL_READ", guardRequired: false, reason: "RISK_RECHECK_REQUIRED"
    });
  }

  assert.deepEqual(planPremiseValidation({
    operation: "WRITE", risk: "HIGH", state: "FRESH", sourceMode: "TTL_ONLY",
    ttlFresh: true, capabilities: ["CAS", "IDEMPOTENCY_KEY"]
  }), { decision: "UNSUPPORTED", validation: "AUTHORITATIVE_READ", guardRequired: true, reason: "VERSIONED_WRITE_REQUIRED" });
});

test("risk-aware writes avoid redundant pre-reads but still require guard, frontier and fencing", () => {
  const base = {
    operation: "WRITE",
    risk: "CRITICAL",
    state: "FRESH",
    sourceMode: "VERSIONED",
    hasVersionToken: true,
    causalFrontierComplete: true,
    leaseRequired: true
  };
  assert.deepEqual(planPremiseValidation({ ...base, capabilities: ["CAS", "IDEMPOTENCY_KEY", "CAUSAL_FRONTIER"] }), {
    decision: "UNSUPPORTED", validation: "NONE", guardRequired: true, reason: "FENCED_LEASE_REQUIRED"
  });
  assert.deepEqual(planPremiseValidation({ ...base, capabilities: ["CAS", "IDEMPOTENCY_KEY", "CAUSAL_FRONTIER", "FENCED_LEASE"] }), {
    decision: "USE", validation: "NONE", guardRequired: true, reason: "ATOMIC_GUARD_REQUIRED"
  });
  assert.deepEqual(planPremiseValidation({ ...base, state: "STALE", capabilities: ["CAS", "IDEMPOTENCY_KEY", "CAUSAL_FRONTIER", "FENCED_LEASE", "CONDITIONAL_READ"] }), {
    decision: "REVALIDATE", validation: "CONDITIONAL_READ", guardRequired: true, reason: "STALE_EVIDENCE"
  });
});

test("CAS-observed fresh receipts skip only the extra read and still require CAS", () => {
  const input = {
    operation: "WRITE",
    risk: "CRITICAL",
    state: "FRESH",
    sourceMode: "VERSIONED",
    hasVersionToken: true,
    causalFrontierComplete: true,
    casObservedFreshReceipts: true,
    capabilities: ["CAS", "IDEMPOTENCY_KEY", "CAUSAL_FRONTIER"]
  };
  assert.deepEqual(planPremiseValidation(input), {
    decision: "USE", validation: "NONE", guardRequired: true, reason: "CAS_OBSERVED_FRESH_RECEIPTS"
  });
  assert.deepEqual(planPremiseValidation({ ...input, capabilities: ["CONDITIONAL_ACTION", "IDEMPOTENCY_KEY", "CAUSAL_FRONTIER"] }), {
    decision: "UNSUPPORTED", validation: "NONE", guardRequired: true, reason: "CAS_REQUIRED_FOR_OBSERVED_RECEIPTS"
  });
});

test("CAS observed receipts do not shortcut incompatible operational gates", async () => {
  const receipt = {
    premiseId: "p1", state: "FRESH", valid: true, identityKey: "a", versionToken: "v1",
    artifactDigest: "sha256:artifact-a", migration: "READY", lease: "lease-a", alerts: "GREEN"
  };
  for (const change of [
    { revoked: true },
    { lease: "lease-b" },
    { alerts: "RED" },
    { migration: "BLOCKED" },
    { artifactDigest: "sha256:artifact-b" }
  ]) {
    const result = await executePremiseGuard(
      { actionDigest: "sha256:action", criticalPremises: ["p1"], requiredCapability: "CAS", idempotencyKey: "op-gate" },
      [receipt],
      { capabilities: ["CAS", "IDEMPOTENCY_KEY"], commit: () => ({ accepted: false, reason: "VERSION_MISMATCH", observedReceipts: [{ ...receipt, ...change }] }) }
    );
    assert.deepEqual(result, { accepted: false, decision: "REVALIDATE", reason: "VERSION_MISMATCH" });
  }
});

test("CAS request saving applies only to repairable conflicts", () => {
  const input = {
    operation: "WRITE", risk: "CRITICAL", state: "FRESH", sourceMode: "VERSIONED",
    hasVersionToken: true, causalFrontierComplete: true, casObservedFreshReceipts: true,
    capabilities: ["CAS", "IDEMPOTENCY_KEY", "CAUSAL_FRONTIER"]
  };
  assert.deepEqual(planPremiseValidation({ ...input, casConflict: "REPAIRABLE" }), {
    decision: "USE", validation: "NONE", guardRequired: true, reason: "CAS_OBSERVED_FRESH_RECEIPTS"
  });
  assert.deepEqual(planPremiseValidation({ ...input, casConflict: "REVOCATION" }), {
    decision: "REJECT", validation: "NONE", guardRequired: true, reason: "REVOCATION_CONFLICT"
  });
  assert.deepEqual(planPremiseValidation({ ...input, casConflict: "INCOMPATIBLE_GATE" }), {
    decision: "UNSUPPORTED", validation: "NONE", guardRequired: true, reason: "INCOMPATIBLE_GATE"
  });
});

test("complete fresh CAS observations can replace invalidated evidence without a reread", () => {
  assert.deepEqual(planPremiseValidation({
    operation: "WRITE",
    risk: "CRITICAL",
    state: "INVALID",
    sourceMode: "VERSIONED",
    hasVersionToken: true,
    causalFrontierComplete: true,
    casObservedFreshReceipts: true,
    capabilities: ["CAS", "IDEMPOTENCY_KEY", "CAUSAL_FRONTIER"]
  }), {
    decision: "USE", validation: "NONE", guardRequired: true, reason: "CAS_OBSERVED_FRESH_RECEIPTS"
  });
  assert.deepEqual(planPremiseValidation({
    operation: "WRITE",
    risk: "CRITICAL",
    state: "INVALID",
    sourceMode: "VERSIONED",
    hasVersionToken: true,
    causalFrontierComplete: true,
    capabilities: ["CAS", "IDEMPOTENCY_KEY", "CAUSAL_FRONTIER"]
  }), {
    decision: "REJECT", validation: "NONE", guardRequired: true, reason: "INVALID_EVIDENCE"
  });
});

test("lease usability enforces expiry and fencing token", () => {
  const lease = { leaseId: "lease-1", fencingToken: "fence-2", expiresAt: "2026-08-12T19:00:00Z" };
  assert.equal(premiseLeaseUsable(lease, "2026-08-12T18:59:00Z", "fence-2"), true);
  assert.equal(premiseLeaseUsable(lease, "2026-08-12T18:59:00Z", "fence-1"), false);
  assert.equal(premiseLeaseUsable(lease, "2026-08-12T19:00:00Z", "fence-2"), false);
});

test("guard rejects a fresh receipt whose lease is expired or fenced differently", async () => {
  let commits = 0;
  const result = await executePremiseGuard(
    { actionDigest: "sha256:action", criticalPremises: ["p1"], requiredCapability: "CAS", idempotencyKey: "op-lease", lease: { leaseId: "lease-1", fencingToken: "fence-2" } },
    [{ premiseId: "p1", state: "FRESH", valid: true, identityKey: "a", versionToken: "v1", lease: { leaseId: "lease-1", fencingToken: "fence-1", expiresAt: "2000-01-01T00:00:00Z" } }],
    { capabilities: ["CAS", "IDEMPOTENCY_KEY", "FENCED_LEASE"], commit: () => { commits += 1; return { accepted: true }; } }
  );
  assert.deepEqual(result, { accepted: false, decision: "REJECT", reason: "INVALID_LEASE" });
  assert.equal(commits, 0);
});
