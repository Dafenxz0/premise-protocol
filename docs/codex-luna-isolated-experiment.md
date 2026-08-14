# Isolated Codex/Luna integration experiment

The static Public-Boundary Check is deliberately not a real agent run. This
experiment is the separate live path for testing whether a Codex or Luna
worker can adopt PREMiSE from the same public material an external developer
would receive.

## Isolation contract

The runner creates a fresh temporary root under `.tmp/adoption/` containing
only:

- the public PREMiSE Skill and its referenced public material;
- the public SDK manifest and README;
- the standalone plugin README and MCP mapping;
- an optional local `@premise/sdk` tarball produced by the package gate;
- a task and a machine-readable allowed-file manifest.

The worker is instructed to write only to `candidate/`. The runner removes
credential-like environment variables, sets network and credential controls to
disabled, and never supplies the repository checkout, benchmark answers, or
an oracle. The evaluator rejects private imports, repository-relative imports,
credential literals, undeclared input reads, and candidates that do not use the
public SDK package.

This is a process-boundary experiment, not a claim of kernel-level sandboxing:
the configured Codex/Luna command must itself honor the no-network and
workspace restrictions. Results therefore remain experimental evidence until
repeated in a product sandbox.

## Commands

Prepare the sealed input without launching an agent:

```powershell
pnpm adoption:codex-luna:contract
node benchmarks/adoption-reality/codex-luna-experiment/runner.mjs --prepare-only
```

Run an external Codex or Luna command only when explicitly configured. The
value is a JSON array; use `{prompt}` as the final prompt placeholder or let
the runner append the prompt:

```powershell
$env:PREMISE_LUNA_COMMAND='["codex","exec","--sandbox","workspace-write","{prompt}"]'
node benchmarks/adoption-reality/codex-luna-experiment/runner.mjs --run
```

The live result is `PASS`, `FAIL`, or `NOT_RUN`; an absent command is never
converted into a pass. The report is generated under `.tmp/` and is not
committed. CI runs the contract gate only, so ordinary CI remains deterministic
and credential-free while a separately authorized Codex/Luna run can be
audited with the same evaluator.
