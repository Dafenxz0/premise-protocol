# PREMiSE Scientific MVP — preregistration

This document freezes the first scientific comparison before model-provider data is used.

The pre-scientific implementation baseline is frozen at commit
`bff0977` (`Optimize batched validation and connector reads`). A changed
runner or scenario creates a new campaign version; existing results are not
rewritten.

## Primary question

For the same mutable task, does PREMiSE reduce the cost per correctly completed task with current information while preventing unsafe actions?

## Arms

- `basic`: initial memory without revalidation.
- `conventional`: source read before acting without CAS protection.
- `smart`: versions, event probe, caching and CAS without PREMiSE dependency semantics.
- `always`: source read and CAS before every action, with bounded retries.
- `premise`: PREMiSE freshness decision, selective revalidation, CAS and recovery.
- `perfect`: deterministic no-LLM control; it is a diagnostic ceiling, not a commercial competitor.

The Ideal Oracle Revalidator is evaluator-only. It never crosses the agent boundary and is not ranked as a product arm.

## Unit and denominators

One task is one paired observation for every arm. A safe successful task is `completed = true` and `unsafeAction = false`. A safe attempt is an accepted action or rejection with `unsafeAction = false`; a task that aborts without an action is not a safe attempt.

The report must show both:

```text
Cost per Safe Attempt = total measured cost / safe attempts
CSFA = total measured cost / safe successful tasks
```

If provider billing is unavailable, the value is `UNKNOWN`; a synthetic payload proxy is reported separately and never called provider cost.

## Fixed metrics

- Safe Completion Rate.
- Unsafe Action Rate.
- False Block Rate.
- Recovery Rate.
- TOCTOU Escape Rate.
- Connector requests, reads, writes and source items.
- Input, output and cached tokens.
- Tool calls, retries, replans and wasted work.
- p50/p95 latency.
- Provider CSFA and Total CSFA.

## Dataset split

Development and public adversarial tasks may be used for implementation. Validation is used only for release-candidate checks. The sealed holdout is generated independently, hashed, and never used for tuning. A failed holdout is retained as a failed result; it is not regenerated to obtain a pass.

## Statistical plan

All campaigns use paired tasks, deterministic seeds, bootstrap confidence intervals and a preregistered minimum detectable effect. The runner calculates required sample sizes for:

- the selected unsafe-action difference;
- the selected safe-completion difference;
- the selected relative CSFA difference and declared cost coefficient of variation.

The standard planning point is alpha `0.05` and power `0.80`; the actual MDE and sample size are written to the run manifest before execution.

## Scope of the first gate

Scientific MVP requires:

- sealed deterministic holdout;
- capability-matched Smart and strong Always baselines;
- filesystem/Git-compatible controlled world;
- two real LLM families when credentials are available;
- observed provider cost or an explicit `NOT_RUN` result;
- blind examiner and oracle-leakage checks.

The full multi-domain campaign is allowed only if this gate is passed.

## Claims not allowed

This preregistration does not authorize claims about universal truth, production availability, all LLMs, all providers, GA readiness, or guaranteed monetary savings.
