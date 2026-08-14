# Fenced single-flight validation

`FencedSingleFlightCoordinator` is a small in-process coordinator for one
specific problem: several callers may ask to validate the same resource while
another caller is asking about a newer version.

It does four things:

1. Coalesces concurrent calls only when one complete
   `PremiseValidationScope` matches: tenant, resource, incarnation, version
   scheme/token, validator, authorization, policy, query, scopes, change set
   and causal frontier. Legacy requests without that complete scope remain
   callable but are isolated rather than assigned a partial sharing key.
2. Assigns one monotonic fencing token to each resource-version generation.
   Complete scopes with the same tenant, resource, incarnation and
   version scheme/token keep that token even when their query, authorization
   or policy differs; those dimensions select different work but do not prove
   a resource change. A new incarnation or version advances the token. A
   result from an older generation, or a source result that echoes the wrong
   token, becomes `UNKNOWN/FENCED` and cannot be used. Legacy isolated calls
   retain their conservative historical behavior.
3. Keeps tenant scopes separate. A promise is never shared across tenants,
   even when the resource and expected version are identical.
4. Converts timeout and abort into `UNKNOWN` without retrying the source.

The coordinator is deliberately not a store, lock service, distributed lease,
or side-effect executor. The injected source performs one validation only:

```ts
const coordinator = new FencedSingleFlightCoordinator({
  validate: ({ tenantId, resource, expectedVersion, scope, fencingToken, signal }) =>
    connector.validate({ tenantId, resource, expectedVersion, scope, fencingToken, signal })
});

const result = await coordinator.validate({
  scope: {
    tenantId: "acme",
    resourceId: "github://repo/pull/42",
    incarnationId: "pull:42",
    versionScheme: "github.commit",
    versionToken: "abc123",
    validatorId: "github-read",
    authorizationContextDigest: "auth:reader",
    policyDigest: "policy:pull-read",
    queryDigest: "query:head",
    scopes: ["read:head"],
    changeSetDigest: null,
    causalFrontier: []
  },
  timeoutMs: 500
});
```

The source must echo the supplied `fencingToken` in its outcome. A successful
outcome can be `UNCHANGED`, `CHANGED` or `MISSING`; an unavailable outcome is
`UNKNOWN`. Ordinary source errors are propagated to every coalesced caller so
they are not silently mistaken for fresh evidence. Abort-like source errors
are normalized to `UNKNOWN/ABORTED`.

Timeout is a flight-level decision. The first caller's timeout and abort signal
govern the shared flight; later callers with the same exact key receive that
same promise. A follower cannot cancel work for other tenants or callers.

When a timeout or abort fires, the public result resolves immediately as
`UNKNOWN`, but the source is allowed to finish its already-started read. The
coordinator does not start a replacement flight until that source settles for
the exact key. This prevents a timeout from becoming an implicit retry. A
later version may start its own flight and fences the older one.

The implementation is intentionally process-local. A deployment that needs
cross-process fencing must provide an external authority and conditional
source operation around this primitive; this file does not pretend an
in-memory token is a distributed lock.
