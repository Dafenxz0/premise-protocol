# PremiseBench-Agent evidence contract

Every publishable campaign must include a manifest containing the commit, Node and pnpm versions, runner hash, dataset hash, seed, policy IDs, model/provider configuration, prompt hash, tool-schema hash, pricing snapshot and status of every optional dependency.

The evidence bundle has these logical files:

- `plan.json`: MDE/power, task hash, policies and environment frozen before execution.
- `manifest.json`: immutable run configuration and hashes.
- `dataset-manifest.json`: public task metadata without mutation labels.
- `blind-report.json`: anonymized candidates and evaluator metrics.
- `mapping.private.json`: candidate-to-policy mapping, retained separately.
- `traces.jsonl`: raw per-task traces with secrets and oracle fields removed.
- `summary.json`: unblinded report generated only after the blind report is sealed.
- `tables.md`: human-readable safety and cost tables.
- `power.json`: preregistered MDE and required sample sizes.

`UNKNOWN`, `NOT_RUN` and `NOT_MEASURED` are valid evidence states. They must not be converted into zero, success or an estimated provider cost.

The examiner must be able to verify that no candidate input contains `expected`, `oracle`, `groundTruth`, `mutation`, `outcome` or labels. Any violation invalidates the campaign.
