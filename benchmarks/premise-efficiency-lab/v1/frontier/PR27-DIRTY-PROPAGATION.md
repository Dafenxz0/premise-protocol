# PR27 — dirty propagation locality

## Scope

PR27 optimizes the repeated-signal path after a root is already represented at
the same or stronger severity. The runtime keeps an indexed affected closure
for a stable root, invalidates that index when membership changes, and skips
re-propagation and cache scans for a semantic no-op.

The optimization is intentionally narrow:

- a severity upgrade still propagates through the maintained graph;
- distinct causal roots remain distinct internally;
- resolving a derived node cannot clear its dependency's cause;
- tombstone reactivation rebuilds the affected state before reuse;
- UNKNOWN and root-state budget exhaustion remain fail-closed;
- graph changes and complete state restores clear the affected-closure cache.

## Evidence contract

The benchmark runs three independent roles:

1. the candidate built from the current workspace;
2. the exact compiled baseline artifact at the PR27 manifest commit;
3. `FullTraversalReference`, used only as a semantic oracle.

The baseline is verified from
`pr27-baseline-manifest.json` before the benchmark starts. It is not a model
or hand-written reconstruction, and the reference is never used as a physical
work denominator.

## Scenarios

The campaign covers:

- repeated dirty signals for one root;
- alternating already-covered roots;
- a cache-locality workload with many unrelated cached targets;
- `STALE → UNKNOWN → INVALID` severity escalation;
- resolve, partial observation and root reactivation;
- reconvergent/dominated roots;
- a separate UNKNOWN resolve check;
- a root-state budget exhaustion check.

The smoke and medium profiles use the same event semantics with deterministic
sizes and seed. The generated JSON and Markdown live under `.tmp/` and are
ignored by Git.

## Physical accounting

Each candidate and baseline operation must satisfy the existing 17-counter
contract. The runner independently checks finite non-negative counters,
maintenance/query work equations, graph-work equations and:

```text
cacheEntriesScanned = cacheInvalidations + cacheEntriesPreserved
```

The comparable unit is primitive work:

```text
maintenanceWork + queryWork
```

Initialization is reported inside operation breakdowns but is excluded from the
action-time comparison because both engines receive the same graph fixture.
Warm-up work is also retained per row in `summary.json`; it is excluded from
the action-time denominator explicitly, never converted to an implicit zero.

## Gates and claims

PR27 is eligible only when:

1. the baseline commit and artifact digest verify;
2. candidate and baseline match the independent reference;
3. every emitted counter reconciles;
4. UNKNOWN and budget exhaustion remain incomplete and UNKNOWN;
5. the targeted locality rows show at least one 20% reduction and no more than
   5% regression in the targeted rows.

If safety/accounting pass but the performance gate does not, the result is
`INCONCLUSIVE` and no optimization claim is eligible. The campaign does not
measure tokens, provider cost, external requests, latency, LLM quality or
commercial savings. The current campaign is a single-seed deterministic
calibration, not a blind external evaluation; it is not a general claim over
all topologies or workloads.

## Reproduce

```powershell
pnpm benchmark:efficiency:v1:frontier:propagation
pnpm build; node benchmarks/premise-efficiency-lab/v1/frontier/propagation.mjs --profile=medium
node benchmarks/premise-efficiency-lab/v1/frontier/propagation-report.mjs --input=.tmp/premise-efficiency-lab/v1/frontier-propagation/smoke.json --output=.tmp/premise-efficiency-lab/v1/frontier-propagation/smoke
```
