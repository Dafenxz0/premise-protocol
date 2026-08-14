# Static Public-Boundary Check

This check measures the smallest useful external integration with the public
PREMiSE SDK. It is an offline structural check, not a model benchmark, not a
real agent run, and not evidence that a server, connector, or credential works.

## Isolation boundary

The agent input is frozen to
`benchmarks/adoption-reality/static-public-boundary-check/fixtures/isolated-public-consumer/`:

- `README.md` with the task;
- `package.json` with the public `@premise/sdk` dependency;
- `docs/api.md` and `docs/integration.md` with public documentation.

The agent does not receive the prompt manifest, checker, reference candidate,
private runtime packages, benchmark data, or repository checkout. A valid
candidate imports `@premise/sdk` only. Workspace aliases, repository-relative
imports, private packages, and evaluator answer data fail closed.

The checker never launches Codex, Luna, or another agent; it does not install a
package, call a URL, read an environment secret, or need a credential.
`reference-run` and
`rejected-internal` are static fixtures used by `--self-check`; no candidate
module is executed.

## Trace contract

The evaluator-side `run.json` contains deterministic events:

```json
{
  "format": "premise-static-public-boundary-check-trace/1",
  "success": true,
  "filesChanged": ["agent.mjs"],
  "internalImports": [],
  "docsReads": ["README.md", "docs/api.md"],
  "errors": [],
  "events": [
    { "type": "read", "path": "README.md", "atMs": 0 },
    { "type": "success", "atMs": 37 }
  ],
  "timeToFirstSuccessMs": 37
}
```

The checker recomputes the arrays rather than trusting the summary:

| Field | Meaning |
| --- | --- |
| `success` | The public-boundary and trace checks all pass. |
| `filesChanged` | Candidate files other than `run.json`. |
| `internalImports` | Detected private, workspace, repository-relative, or non-public package imports. |
| `docsReads` | Unique reads of `README.md` or `docs/*.md` from the supplied input. |
| `errors` | Boundary, trace, evaluator-data, credential, and candidate-reported errors. |
| `timeToFirstSuccessMs` | `atMs` of the first success event; no wall clock is used. |

The same fields are repeated under `metrics` for machine consumers. Counts,
`packageReads`, `publicReads`, `agentLaunched: false`,
`credentialsUsed: false`, and `deterministic: true` make the evidence explicit.

## Run

From the repository root:

```powershell
node benchmarks/adoption-reality/static-public-boundary-check/checker.mjs
node benchmarks/adoption-reality/static-public-boundary-check/checker.mjs --self-check
```

To inspect another static candidate without changing the repository:

```powershell
node benchmarks/adoption-reality/static-public-boundary-check/checker.mjs --candidate C:\path\to\candidate
```

The default reference result is deterministic and should be `PASS`; the
negative fixture should be `FAIL` because it imports a private runtime package.
