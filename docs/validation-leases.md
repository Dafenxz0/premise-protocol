# Validation leases (PR50)

This module is a small, fail-closed contract for coordinating validation work
on one `(tenantId, resourceId)` scope. An owner acquires a lease, keeps it alive
with renewals, and must present the same `leaseId` and fencing token before a
validation result can be used.

It is intentionally a contract slice, not a claim that PREMiSE now has a
distributed high-availability lease service.

## What the contract guarantees

- One active lease per exact tenant/resource scope in an atomic store.
- A lease has an owner, a unique caller-supplied `leaseId`, an absolute expiry,
  and a positive fencing token.
- Fencing tokens increase monotonically for each tenant/resource scope and are
  never reused after release or expiry.
- Renewal requires the current owner, lease ID, and fencing token.
- Validation and release reject expired, missing, competing, or fenced leases.
- A backwards, invalid, or unavailable clock fails closed.
- A store exception fails closed; it never becomes an authorization.

The manager returns a decision rather than throwing for expected operational
failures:

| Decision | Meaning |
| --- | --- |
| `ACQUIRED` | This caller owns a new lease. |
| `ALREADY_HELD` | The same owner and lease ID already hold it. |
| `CONTENDED` | Another active lease owns the scope. |
| `RENEWED` | The current lease was extended. |
| `RELEASED` | The current lease was released. |
| `VALID` | Owner, lease ID, token, scope, and expiry all match. |
| `REJECTED` | The operation must not proceed. Inspect `reason`. |

## Minimal usage

The public PR50-PR51 surface exports the manager from the package root:

```ts
import { ValidationLeaseManager } from "@premise/runtime-core";

const leases = new ValidationLeaseManager({
  leaseDurationMs: 30_000,
  now: () => Date.now()
});

const acquired = leases.acquire({
  tenantId: "tenant:acme",
  resourceId: "github:acme/app:main",
  owner: "agent:checkout-7",
  leaseId: "run:42"
});

if (!acquired.accepted || acquired.lease === undefined) {
  // Do not validate or write while the lease is not acquired.
  throw new Error(`validation lease rejected: ${acquired.reason}`);
}

const check = leases.validate({
  tenantId: acquired.lease.tenantId,
  resourceId: acquired.lease.resourceId,
  owner: acquired.lease.owner,
  leaseId: acquired.lease.leaseId,
  fencingToken: acquired.lease.fencingToken
});

if (check.decision !== "VALID") {
  // Fail closed before using the observation or attempting an action.
  throw new Error(`validation lease is not usable: ${check.reason}`);
}
```

The token must also be passed to the downstream conditional write. A lease
check by itself cannot stop a connector that ignores fencing tokens.

## Store boundary

`ValidationLeaseStore` is the seam for a future durable adapter. Its acquire,
renew, release, and validate operations must be atomic for an exact tenant and
resource key. A real adapter must persist the fencing counter durably and
compare the presented token at the write boundary; a best-effort cache is not
enough.

`InMemoryValidationLeaseStore` is only a deterministic reference store. Its
synchronous `Map` makes race cases reproducible inside one process. It provides
no cross-process coordination, replication, failover, persistence, or network
failure semantics.

## Clock and expiry

The manager accepts an injected millisecond clock so tests can place operations
exactly before and at expiry. Time is valid while `now < expiresAt`; at the
boundary the lease is expired. A clock value that moves backwards is rejected
and does not authorize a later operation. Production adapters must still
define how their store's clock and the caller's clock relate; this prototype
does not solve clock synchronization.

## Explicit non-claims

PR50 does **not** prove distributed correctness, HA, crash recovery, quorum
behavior, fencing against an external database, or production security. It
also does not use Redis or another external service. Those claims require a
durable atomic store, failure-injection tests across processes, and an
end-to-end connector that enforces the token.
