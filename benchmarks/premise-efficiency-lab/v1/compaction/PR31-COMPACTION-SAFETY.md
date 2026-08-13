# PR31 compaction safety gate

Status: **NO-GO**.

This directory is the PR31 evaluation boundary. It records the safety contract
for a possible future compaction implementation; it does not implement or
wire compaction into the runtime. The current long-horizon measurement remains
measurement-only, so no compaction claim is authorized here.

## Decision rule

`GO` is accepted only when a declaration has all of the following:

```json
{
  "status": "GO",
  "compactionImplemented": true,
  "invariants": {
    "<required-id>": {
      "status": "PASS",
      "deterministic": true,
      "independentOracle": true,
      "testFile": "...",
      "testCount": 1
    }
  }
}
```

Every required invariant must be present and have a passing deterministic test
with an independent oracle. Missing, partial, failed, malformed or
non-deterministic evidence returns `NO-GO`. A declaration of `GO` without the
invariants is therefore rejected by the gate, not treated as an incomplete
pass.

The executable contract is in `gate.mjs`; `gate.test.mjs` keeps the current
verdict and fail-closed behavior deterministic. The complete declaration in
the tests is only a proof-shaped contract fixture, not evidence that
compaction exists.

## Required invariants

| ID | Safety property | Minimum evidence |
| --- | --- | --- |
| `semantic-equivalence` | Compacted and un-compacted histories produce the same observable result. | Differential test against an independent oracle. |
| `event-continuity` | Gaps, late events, reordering and conflicts cannot become fresh state. | Continuity and replay tests. |
| `dependency-closure` | Active records, dependency closure and invalidation/frontier state survive compaction. | Graph/frontier equivalence tests. |
| `scope-and-incarnation` | Tenant, resource, authorization, version and incarnation boundaries remain distinct. | Cross-scope and incarnation-separation tests. |
| `action-replay-safety` | Stale, replayed and TOCTOU-sensitive actions remain rejected. | Stale-replay and conditional-action tests. |
| `crash-atomicity` | Interrupted compaction recovers to a valid pre- or post-compaction state. | Interruption/restart tests. |
| `audit-retention` | Required provenance and security-relevant audit boundaries are not silently discarded. | Retention-boundary and audit-preservation tests. |

No one may change the verdict to `GO` by adding a label, a benchmark result or
a performance measurement. The implementation, the invariant tests and their
independent evidence must exist before the gate can accept that declaration.

## Verification

```powershell
node --test benchmarks/premise-efficiency-lab/v1/compaction/gate.test.mjs
```

This test is intentionally isolated from `packages/runtime-core` and from the
PR30 horizon files.
