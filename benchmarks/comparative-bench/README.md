# Comparative benchmark

This benchmark runs the same 24 episodes twice:

- **No protocol** uses the remembered value without checking the source.
- **PREMiSE** records provenance, observes a source change, revalidates and calls `check()` before use.

It separates safety from usefulness. A safe rejection in a missing-source case is not counted as a successful task, but it is counted as safe. `results.json` contains paired metrics and one trace per strategy and episode.

```powershell
fnm env --shell powershell | Out-String | Invoke-Expression
fnm use 24
pnpm build
node benchmarks/comparative-bench/runner.mjs
node benchmarks/comparative-bench/self-check.mjs
```
