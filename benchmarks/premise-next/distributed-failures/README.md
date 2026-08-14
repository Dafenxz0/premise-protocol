# Distributed failure campaign

This campaign exercises the actual `PostgresValidationFlightStore` class with
an in-memory PostgreSQL-shaped adapter. It covers leader crash, expiry
takeover, stale completion fencing, completed-receipt replay, scope and tenant
isolation, follower timeout and abort.

The default run is deterministic contract evidence. It is **not** a claim that
multiple OS processes or a real PostgreSQL server were used. `--mode=live`
returns `SKIPPED` unless an explicit live driver configuration is supplied;
missing infrastructure is never converted into a pass.

```bash
pnpm build
node --test benchmarks/premise-next/distributed-failures/runner.test.mjs
node benchmarks/premise-next/distributed-failures/runner.mjs
```
