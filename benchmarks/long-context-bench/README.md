# Long-context benchmark

This benchmark measures the metadata protocol, not the memory content. It builds chain, fanout and shared-support graphs at 1k and 5k nodes by default; `--full` adds 10k and 25k. The payload size is reported separately and is never stored in PREMiSE envelopes.

```powershell
fnm env --shell powershell | Out-String | Invoke-Expression
fnm use 24
pnpm build
node benchmarks/long-context-bench/runner.mjs --profiles 1000,5000 --max-ms 120000
node benchmarks/long-context-bench/self-check.mjs
```

The result records operation totals, per-operation p50/p95, heap delta, serialized metadata bytes, affected-node counts and an isolation invariant for unrelated graph branches.
