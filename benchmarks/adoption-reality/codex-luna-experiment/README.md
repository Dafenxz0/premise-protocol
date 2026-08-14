# Isolated Codex/Luna experiment

This directory contains the runner for the real-agent adoption experiment.
It is separate from `static-public-boundary-check/`: that older gate is a
deterministic structural fixture and deliberately never launches an agent.

The runner seals a temporary input from the public PREMiSE Skill, public SDK
package artifact, public plugin mapping, and public docs. A configured Codex
or Luna process must write its candidate under the temporary `candidate/`
directory. The evaluator then installs the supplied SDK tarball offline,
imports the candidate, and rejects private imports, credentials, undeclared
reads, and missing success evidence.

```powershell
node benchmarks/adoption-reality/codex-luna-experiment/runner.mjs --prepare-only
$env:PREMISE_LUNA_COMMAND='["codex","exec","{prompt}"]'
node benchmarks/adoption-reality/codex-luna-experiment/runner.mjs --run
```

Without an explicitly configured command the result is `NOT_RUN`, never a
synthetic `PASS`. Generated input, candidate, and reports remain under `.tmp/`
and are not repository artifacts.
