# PR28 — completed receipt reuse and validation deduplication

Status: **merged runtime change; corrected evidence certified by PR29**.

This cycle adds an opt-in completed-validation cache to the runtime. It is
separate from in-flight single-flight promises and is usable only when the
caller supplies a complete `PremiseReceiptSharingScope` factory. Without that
factory, the runtime isolates record-local validators instead of sharing by a
partial evidence key.

The cache is bound to the observable tenant, source, validator and evidence
version, plus the caller-provided incarnation, authorization, query, policy,
change-set and causal-frontier dimensions. Receipts are accepted only for
`UNCHANGED`/`FRESH` observations with a non-future timestamp. Source
invalidation, replacement and restore clear or fence cached observations.
Expired, negative, unknown, changed, missing, malformed and failed results are
never reusable.

## Physical benchmark

The benchmark loads the compiled champion artifact from the frozen manifest
and compares it with the candidate runtime under the same deterministic task
schedule. It counts physical validator invocations; it does not claim provider
requests, tokens, latency, RAM or cost.

```powershell
pnpm build
node benchmarks/premise-efficiency-lab/v1/receipts/reuse.mjs --profile=smoke
node benchmarks/premise-efficiency-lab/v1/receipts/reuse.mjs --profile=medium
```

Champion manifest:

```text
commit: 49f89f5ad8304d5fac5c7b78a109e6df761762a6
artifact: sha256:526fb01aa6df7550de9e03284f0723b6ba17669e54fbf6f848fcf52787dce0c6
Node: 24 / pnpm: 10.13.1 / TypeScript: 7.0.2
```

The medium campaign uses 1,000 records in the reuse, stampede, authorization,
rotation and expiry rows. The observed physical validator counts were:

| Scenario | Champion | Candidate | Candidate reduction | Safety gate |
| --- | ---: | ---: | ---: | --- |
| Sequential completed reuse | 2,000 | 1 | 99.95% | PASS |
| Concurrent stampede | 1 | 1 | 0% | PASS |
| Authorization isolation | 1,000 | 2 | 99.80% | PASS |
| Source rotation | 2,000 | 1,001 | 49.95% | PASS |
| Expiry | 2,000 | 2 | 99.90% | PASS |

The rotation row deliberately charges all 1,000 post-change validations; the
candidate saves only the unchanged pre-change wave. The stampede row shows
that completed receipts do not pretend to improve work that in-flight
single-flight already coalesces.

The benchmark rows cover validator failure and in-flight cache fencing. The
runtime unit suite, outside the physical comparison rows, also covers
externally staled records and a reported version that differs from the input
evidence. These are not provider-level or connector-level CAS tests.

PR29 corrected the original evidence runner: it now uses a separate oracle
process, compares full reports/record state/history rather than only visible
status, exercises all caller-owned sharing dimensions plus tenant isolation
and incomplete-scope fail-closed behavior, records cache state immediately
after source invalidation, retains smoke and medium artifacts separately, and
requires a clean candidate for `status: PASS`.

## Scope of the result

This is a runtime validation-work result, not a commercial efficiency claim.
No partial/subsumption reuse is implemented: a receipt for `[A,B,C,D]` is not
used for `[A,B]`. That experiment is intentionally deferred until a separate
proof and adversarial matrix can establish safe monotonicity. No event-stream,
provider-cost or token conclusions follow from this PR.
