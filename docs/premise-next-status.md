# PREMiSE NEXT status

This page separates what is implemented from what is measured and what is
still unproven. It is the status snapshot for the current `main` line.

## Implemented

| Area | Current evidence | Boundary |
| --- | --- | --- |
| Guarded actions | Public `check -> revalidate -> act` contract and root import smoke | The connector still owns authorization and its atomic write |
| Validation leases | In-memory fail-closed contract plus PostgreSQL async adapter | A lease is useful only when the downstream write enforces its token |
| Fenced validation | Exact-flight coalescing with timeout, abort and fencing behavior; durable PostgreSQL validation-flight adapter | The in-memory coordinator is process-local; distributed capacity and crash testing are still unmeasured |
| Distributed validation flight | PostgreSQL `LEADER`/`FOLLOWER`/`COMPLETED` claims, expiry takeover, monotonic fencing and forced tenant RLS | Opt-in integration path; this is an adapter contract, not a production-scale availability or throughput result |
| Coherence storm | 100 logical workers, authorization scopes, tenant isolation, expiry, mutation, event and ABA phases | Deterministic in-memory smoke; not a capacity or multi-process benchmark |
| Independent reference | Python stdlib implementation, 24 JSON vectors, and 15 shared TypeScript semantic-vector checks | The complete guarded-chain cross-language equivalence gate is still required |

## Semantic conformance smoke

The current local gate executes 15 shared negative-premise, predicate,
receipt-subsumption and receipt-selection vectors in TypeScript. The Python
reference passes its four test groups and all 24 vector cases. This establishes
agreement for the published semantic slice; it does not make the entire runtime
or every connector cross-language equivalent.

## Measured smoke result

The default seed `premise-next-storm-20260814` reports 111 physical validations
and 689 joins across the eight storm phases. Reproduce it with
`node benchmarks/premise-next/storm/runner.mjs`. It records 0 cross-tenant
shares, 0 stale actions accepted and 0 old fence commits. These are
contract-smoke results, not a claim that all agents or connectors will achieve
the same ratios.

## Not yet a claim

PREMiSE NEXT is not a universal memory system, retrieval engine, vector store,
cloud service or authority on truth. The repository does not yet provide an
independent external holdout, a production-scale distributed capacity result,
provider-cost evidence, or a universal connector guarantee. The real PostgreSQL
flight test is opt-in and is reported as `skipped` when `POSTGRES_URL` or `pg` is
unavailable; a local double is never presented as real PostgreSQL evidence.
Missing optional campaign credentials are reported as `skipped`, never as
`pass`.

## Reproduce the local evidence

```bash
node --test benchmarks/premise-next/storm/runner.test.mjs
node benchmarks/premise-next/storm/runner.mjs
python -m unittest discover -s reference/python -p "test_next_protocol.py"
pnpm conformance:next
pnpm --filter @premise/store-postgres test
pnpm build
pnpm test
```
