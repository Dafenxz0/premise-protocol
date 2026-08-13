import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryValidationLeaseStore, ValidationLeaseManager } from "../dist/validation-lease.js";

const scope = { tenantId: "tenant:acme", resourceId: "resource:checkout" };

function harness(start = 1_000, durationMs = 100) {
  const clock = { value: start };
  const store = new InMemoryValidationLeaseStore();
  const manager = new ValidationLeaseManager({ store, now: () => clock.value, leaseDurationMs: durationMs });
  return { clock, store, manager };
}

function acquire(manager, owner, leaseId, extra = {}) {
  return manager.acquire({ ...scope, owner, leaseId, ...extra });
}

test("contenders get one lease and retries are idempotently rejected", () => {
  const { manager } = harness();
  const first = acquire(manager, "agent:a", "lease:a");
  assert.equal(first.decision, "ACQUIRED");
  assert.equal(first.accepted, true);
  assert.equal(first.lease?.fencingToken, 1);

  const contender = acquire(manager, "agent:b", "lease:b");
  assert.deepEqual(contender, { accepted: false, decision: "CONTENDED", reason: "LEASE_ACTIVE" });

  const retry = acquire(manager, "agent:a", "lease:a");
  assert.deepEqual(retry, { accepted: false, decision: "ALREADY_HELD", reason: "LEASE_ACTIVE" });

  const released = manager.release({ ...scope, owner: "agent:a", leaseId: "lease:a", fencingToken: first.lease.fencingToken });
  assert.deepEqual(released, { accepted: true, decision: "RELEASED", reason: "OK" });
  const afterRelease = acquire(manager, "agent:b", "lease:b");
  assert.equal(afterRelease.decision, "ACQUIRED");
  assert.equal(afterRelease.lease.fencingToken > first.lease.fencingToken, true);
});

test("expiration fails closed and the replacement receives a higher fencing token", () => {
  const { clock, manager } = harness();
  const first = acquire(manager, "agent:a", "lease:a");
  const token = first.lease.fencingToken;

  clock.value = 1_099;
  assert.equal(manager.validate({ ...scope, owner: "agent:a", leaseId: "lease:a", fencingToken: token }).decision, "VALID");

  clock.value = 1_100;
  assert.deepEqual(
    manager.validate({ ...scope, owner: "agent:a", leaseId: "lease:a", fencingToken: token }),
    { accepted: false, decision: "REJECTED", reason: "LEASE_EXPIRED" }
  );
  const replacement = acquire(manager, "agent:b", "lease:b");
  assert.equal(replacement.decision, "ACQUIRED");
  assert.equal(replacement.lease.fencingToken > token, true);
});

test("renew requires the current owner, lease id, and fencing token", () => {
  const { clock, manager } = harness();
  const acquired = acquire(manager, "agent:a", "lease:a");
  const token = acquired.lease.fencingToken;

  assert.deepEqual(
    manager.renew({ ...scope, owner: "agent:b", leaseId: "lease:a", fencingToken: token }),
    { accepted: false, decision: "REJECTED", reason: "OWNER_MISMATCH" }
  );
  assert.deepEqual(
    manager.renew({ ...scope, owner: "agent:a", leaseId: "lease:old", fencingToken: token }),
    { accepted: false, decision: "REJECTED", reason: "LEASE_ID_MISMATCH" }
  );
  assert.deepEqual(
    manager.renew({ ...scope, owner: "agent:a", leaseId: "lease:a", fencingToken: token + 1 }),
    { accepted: false, decision: "REJECTED", reason: "STALE_FENCING_TOKEN" }
  );

  clock.value = 1_050;
  const renewed = manager.renew({ ...scope, owner: "agent:a", leaseId: "lease:a", fencingToken: token });
  assert.equal(renewed.decision, "RENEWED");
  assert.equal(renewed.lease.fencingToken, token);
  assert.equal(renewed.lease.expiresAt, 1_150);
});

test("a stale lease cannot validate or release after fencing changes", () => {
  const { clock, manager } = harness();
  const old = acquire(manager, "agent:a", "lease:a");
  clock.value = 1_100;
  const current = acquire(manager, "agent:b", "lease:b");
  assert.equal(current.lease.fencingToken > old.lease.fencingToken, true);

  assert.deepEqual(
    manager.validate({ ...scope, owner: "agent:a", leaseId: "lease:a", fencingToken: old.lease.fencingToken }),
    { accepted: false, decision: "REJECTED", reason: "STALE_FENCING_TOKEN" }
  );
  assert.deepEqual(
    manager.release({ ...scope, owner: "agent:a", leaseId: "lease:a", fencingToken: old.lease.fencingToken }),
    { accepted: false, decision: "REJECTED", reason: "STALE_FENCING_TOKEN" }
  );
  assert.equal(manager.validate({ ...scope, owner: "agent:b", leaseId: "lease:b", fencingToken: current.lease.fencingToken }).decision, "VALID");
});

test("tenant and resource scopes do not contend or cross-authorize", () => {
  const { manager } = harness();
  const tenantB = { tenantId: "tenant:other", resourceId: scope.resourceId };
  const resourceB = { tenantId: scope.tenantId, resourceId: "resource:other" };

  const first = acquire(manager, "agent:a", "lease:a");
  const otherTenant = manager.acquire({ ...tenantB, owner: "agent:b", leaseId: "lease:b" });
  const otherResource = manager.acquire({ ...resourceB, owner: "agent:c", leaseId: "lease:c" });
  assert.equal(first.decision, "ACQUIRED");
  assert.equal(otherTenant.decision, "ACQUIRED");
  assert.equal(otherResource.decision, "ACQUIRED");
  assert.equal(otherTenant.lease.fencingToken, 1);

  assert.deepEqual(
    manager.validate({ ...tenantB, owner: "agent:a", leaseId: "lease:a", fencingToken: first.lease.fencingToken }),
    { accepted: false, decision: "REJECTED", reason: "OWNER_MISMATCH" }
  );
  assert.deepEqual(
    manager.release({ ...scope, owner: "agent:b", leaseId: "lease:b", fencingToken: otherTenant.lease.fencingToken }),
    { accepted: false, decision: "REJECTED", reason: "OWNER_MISMATCH" }
  );
});

test("clock regression is fail-closed without losing the later valid operation", () => {
  const { clock, manager } = harness();
  const acquired = acquire(manager, "agent:a", "lease:a");
  const token = acquired.lease.fencingToken;
  clock.value = 999;
  assert.deepEqual(
    manager.validate({ ...scope, owner: "agent:a", leaseId: "lease:a", fencingToken: token }),
    { accepted: false, decision: "REJECTED", reason: "CLOCK_REGRESSION" }
  );

  clock.value = 1_001;
  assert.equal(manager.validate({ ...scope, owner: "agent:a", leaseId: "lease:a", fencingToken: token }).decision, "VALID");
});

test("store failures never authorize a lease", () => {
  const store = new InMemoryValidationLeaseStore();
  store.acquire = () => { throw new Error("store offline"); };
  const manager = new ValidationLeaseManager({ store, now: () => 1_000 });
  assert.deepEqual(
    acquire(manager, "agent:a", "lease:a"),
    { accepted: false, decision: "REJECTED", reason: "STORE_UNAVAILABLE" }
  );
});
