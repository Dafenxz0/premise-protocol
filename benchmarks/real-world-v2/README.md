# PREMiSE v2 real-world benchmark

This suite has two deliberately different modes:

- `offline`: a reproducible temporal workload with 100 exact tasks, source mutations, a direct baseline, a TTL cache, and PREMiSE invalidation/revalidation. It is suitable for CI and does not pretend to be a live GitHub result.
- `live`: reads one or more real GitHub repositories through the GitHub API. It compares the same endpoint workload with the same answers, records raw traces, request counts, latency percentiles, and whether the run was read-only. Set `PREMISE_GITHUB_REPO=owner/repository` for one repository or `PREMISE_GITHUB_REPOS=owner/repository,owner/other-repository` for a paired multi-repository campaign; `GITHUB_TOKEN` is strongly recommended.

Run the CI-safe suite with:

```text
node benchmarks/real-world-v2/runner.mjs --offline
node benchmarks/real-world-v2/report.mjs
node benchmarks/real-world-v2/self-check.mjs
```

Run a live campaign explicitly (never from the default CI job):

```text
$env:PREMISE_GITHUB_REPO = "Dafenxz0/premise-protocol"
$env:GITHUB_TOKEN = "..."
node benchmarks/real-world-v2/runner.mjs --live --repetitions 20
node benchmarks/real-world-v2/report.mjs
```

For the real-repository campaign used by the GA workflow:

```powershell
$env:PREMISE_GITHUB_REPOS = "Dafenxz0/forgeboard,Dafenxz0/pando,Dafenxz0/riceme-readme-generator"
$env:GITHUB_TOKEN = "..."
node benchmarks/real-world-v2/runner.mjs --live --repetitions 20
node benchmarks/real-world-v2/report.mjs
node benchmarks/real-world-v2/self-check.mjs
```

The multi-repository result keeps one task set and one raw trace, while every
task retains its repository-qualified source. The default GA list contains
three public repositories owned by `Dafenxz0`; `PREMISE_GITHUB_BENCHMARK_REPOS`
can override it as a repository variable without changing the workflow.

The live suite is a read-only observation of a repository. It does not claim that a public repository changed during the run, so its result cannot by itself prove mutation recovery. The offline timeline covers that gap. A release claim needs multiple live runs, a changed-source campaign, raw traces, and an independent reproduction on the same runner settings.

The headline numbers are intentionally simple: correct answers per 100 tasks, requests per 100 tasks, p50/p95 milliseconds, and errors per 100 tasks. The benchmark does not measure model quality or make PREMiSE a database, embedding service, retrieval engine, cloud, or universal truth authority.
