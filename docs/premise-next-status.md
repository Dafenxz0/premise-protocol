# PREMiSE NEXT status

This page separates what is implemented from what is measured and what is
still unproven. It is the status snapshot for the current `main` line.

## Implemented

| Area | Current evidence | Boundary |
| --- | --- | --- |
| Guarded actions | Public `check -> revalidate -> act` contract and root import smoke | The connector still owns authorization and its atomic write |
| Validation leases | In-memory fail-closed contract plus PostgreSQL async adapter | A lease is useful only when the downstream write enforces its token |
| Fenced validation | Exact-flight coalescing with timeout, abort and fencing behavior | The runtime coordinator is process-local; distributed deployment needs the durable adapter |
| Coherence storm | 100 logical workers, authorization scopes, tenant isolation, expiry, mutation, event and ABA phases | Deterministic in-memory smoke; not a capacity or multi-process benchmark |
| Independent reference | Python stdlib implementation and 24 JSON vectors | A complete TypeScript/Python equivalence gate is still required |

## Measured smoke result

The fixed seed reports 111 physical validations and 591 joins across the storm
phases. It records 0 cross-tenant shares, 0 stale actions accepted and 0 old
fence commits. These are contract-smoke results, not a claim that all agents or
connectors will achieve the same ratios.

## Not yet a claim

PREMiSE NEXT is not a universal memory system, retrieval engine, vector store,
cloud service or authority on truth. The repository does not yet provide an
independent external holdout, a production-scale distributed capacity result,
provider-cost evidence, or a universal connector guarantee. Missing optional
campaign credentials are reported as `skipped`, never as `pass`.

## Reproduce the local evidence

```bash
node --test benchmarks/premise-next/storm/runner.test.mjs
node benchmarks/premise-next/storm/runner.mjs
python -m unittest discover -s reference/python -p "test_next_protocol.py"
pnpm build
pnpm test
```
