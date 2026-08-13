# Guarded tools

PR48 adds a small, explicit contract for mutations performed by an agent:

```text
check(tenantId, resource)
  → revalidate(checkResult, expectedVersion)
  → act(revalidatedProof, action, idempotencyKey)
```

The caller must use the result of each phase. `act` accepts only a revalidation
proof created by the same `GuardedTool` instance, and the proof contains the
tenant, resource and version that the action must use. A stale source may become
ready after revalidation; missing, invalid, unknown and version-mismatch results
never produce an action proof.

## Explicit by design

The module does not discover, monkey-patch or implicitly wrap existing tools.
The application supplies three callbacks explicitly:

```ts
const tool = createGuardedTool({
  callbacks: {
    check: ({ tenantId, resource }) => source.check({ tenantId, resource }),
    revalidate: ({ tenantId, resource, expectedVersion }) => source.revalidate({ tenantId, resource, expectedVersion }),
    act: ({ tenantId, resource, expectedVersion, idempotencyKey, action, signal }) =>
      source.conditionalWrite({ tenantId, resource, expectedVersion, idempotencyKey, action, signal })
  }
});

const checked = await tool.check({ tenantId: "tenant:acme", resource: "github://acme/repo/pull/42" });
const ready = await tool.revalidate(checked);
if (ready.ready) {
  await tool.act(ready, { operation: "merge" }, "merge:pull-42:v7");
}
```

The `act` callback remains responsible for the authoritative remote
compare-and-set. PREMiSE cannot make an unguarded remote API safe merely by
calling it through this module.

## Fail-closed behavior

- check or revalidation exceptions become `UNKNOWN` and cannot produce a proof;
- missing, invalid and stale-unrepaired sources cannot be acted on;
- mismatched tenant, resource or version responses are rejected;
- every action requires a non-empty idempotency key;
- a repeated key with the same request reuses the original result;
- a repeated key with different input is rejected;
- a timeout or thrown side-effect error is returned as `UNKNOWN` and cached;
  the module never retries it, because the remote effect may have happened.

The timeout aborts the supplied `AbortSignal`, but a connector must honor that
signal and provide its own atomic conditional write. A timeout is therefore an
unknown outcome, not evidence that no mutation occurred.

This is a contract and in-process state machine, not authentication, a remote
transaction, a durable idempotency store or a universal tool adapter.
