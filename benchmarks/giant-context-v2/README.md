# Giant context v2 benchmark

Measures context selection over large numbers of candidate memories while enforcing a token budget. It reports load count, selected chunks, tokens, p50/p95 selection time, and whether the target facts survived the freshness gate.

The default CI-safe run uses 10k and 100k memories. The 1M profile is explicit because it is a load campaign rather than a fast unit test:

```text
node benchmarks/giant-context-v2/runner.mjs --profiles 10000,100000
node benchmarks/giant-context-v2/runner.mjs --include-1m --profiles 100000,1000000
```

This benchmark measures the context engine, not a model’s answer quality and not a vector database. A result is only comparable when Node version, heap limit, hardware, token estimator, budget, and profile are recorded together.
