# PR26 — incremental frontier repair

## Scope

PR26 evaluates the cost and safety of resolving a dirty root without eagerly
walking and rewriting every descendant. The runtime keeps a bounded tombstone
for the resolved root and removes it when a descendant is queried or touched.
This changes where work is paid; it does not remove work from the accounting.

The implementation is deliberately fail-closed:

- resolving a non-root is a no-op and cannot clear its dependency's cause;
- resolving one root while another remains active preserves the surviving
  frontier and generation;
- `UNKNOWN` cannot be promoted by `resolve()` or `restoreTrust()`;
- only a complete, validated `restoreStates()` snapshot restores trust;
- `restoreTrustedSnapshot()` names that recovery contract explicitly;
- the legacy `restoreTrust()` method remains fail-closed and does not assert
  trust from a boolean toggle;
- duplicate, invalid or incomplete snapshots are rejected;
- root-state/reachability work has a hard budget; exhaustion returns
  `UNKNOWN`/`complete: false` and is never counted as an optimization win.

## Reproducible evidence

```powershell
pnpm benchmark:efficiency:v1:frontier:resolve
```

The command runs the smoke campaign and writes generated artifacts under
`.tmp/premise-efficiency-lab/v1/frontier-resolve/`. It includes chain, fan-out
and reconvergent graphs, root resolution, a non-root resolve, root
reactivation, a complete independent reference comparison and an UNKNOWN
fail-closed case.

The medium diagnostic can be run without publishing its output:

```powershell
node benchmarks/premise-efficiency-lab/v1/frontier/resolve.mjs --profile=medium
```

## Metrics

The report exposes:

- maintenance work paid by `resolve()`;
- total counted maintenance plus query work;
- tombstoned root entries retained at the end of the sequence;
- the eager descendant closure size as a locality diagnostic;
- reference equivalence and accounting reconciliation.

The eager closure size is not a performance baseline. PR24's historical
artifact does not expose the same physical counter contract, so PR26 makes no
percentage claim against it. A future champion comparison must instrument both
sides before reporting a reduction.

## Acceptance gates

PR26 is eligible only when all of these hold:

1. runtime typecheck and package tests pass;
2. frozen PR24 frontier smoke remains differential-equivalent;
3. resolve smoke and medium determinism tests pass;
4. every primitive counter remains reconciled;
5. all UNKNOWN, budget and snapshot checks fail closed;
6. no tokens, provider cost, external request or commercial claim is inferred.
