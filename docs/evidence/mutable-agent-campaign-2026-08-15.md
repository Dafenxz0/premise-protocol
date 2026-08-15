# Mutable-agent campaign — 2026-08-15

> Internal candidate evidence. This record is intentionally narrower than a
> product claim: it demonstrates behavior in the named fixtures and does not
> establish universal safety, production readiness, or lower monetary cost.

## Design

- Two isolated Codex/Luna Max agents received the same difficult SkillProof
  task at commit `3961e733a84c949f1c9c254b6f1481250dee5228`.
- The first arm used the copied public PREMiSE plugin and MCP surface; the
  second used the same task without PREMiSE.
- A mutation process changed release policy, an artifact manifest, a GitHub
  branch-like source and a security incident after the first observation.
  Release notes stayed unchanged as a fresh control.
- Side effects were simulated behind a loopback action server. No real
  publication, merge or repository mutation was allowed.
- A separate blind Luna Max evaluator saw only anonymized `system-a` and
  `system-b` packets. It did not receive raw reports, arm names, prompts or
  repository internals.
- The deterministic stress extension used six isolated worlds — filesystem,
  GitHub-like, dependency, TOCTOU, error and mixed — with 50 tasks each.
  It covered 300 tasks and 162 mutated or errored cases.

## Isolated real-LLM task

| Signal | PREMiSE arm | Baseline arm |
| --- | ---: | ---: |
| Changed-source decisions correct | **4/4 · 100%** | 1/4 · 25% |
| Unsafe stale actions | **0** | 3 |
| Fresh control completed safely | 1/1 · 100% | 1/1 · 100% |
| Terminal MCP calls | 15 | 0* |

`*` The baseline used a batched shell read rather than the MCP surface, so the
last row is not an apples-to-apples cost comparison. It is reported to make
the instrumentation boundary visible, not to claim that PREMiSE is cheaper in
this run.

## Deterministic mutation stress

| Signal | PREMiSE | Baseline memory |
| --- | ---: | ---: |
| Tasks / mutated-or-errored | 300 / 162 | 300 / 162 |
| Changed/error decisions correct | **162/162 · 100%** | 0/162 · 0% |
| Unsafe actions | **0/113 · 0%** | 162/275 · 58.91% |
| Safe completions | **113/113 · 100%** | 113/275 · 41.09% |
| Source reads | 300 | 300 |
| Validations / guards | 275 / 240 | 0 / 0 |
| Tool calls | 815 | **575** |
| Requests per safe completion | 7.21 | **5.09** |

## Interpretation

The safety result is strong in this campaign: PREMiSE detected every changed or
errored case and produced no unsafe action, while the baseline had 162 unsafe
actions in the deterministic stress and three in the isolated LLM task.

The efficiency result is not yet a win. The baseline spends 29.45% fewer raw
tool calls in this particular model because it does not validate or guard; it
also completes only 41.09% of attempted actions safely. PREMiSE currently pays
validation and guard overhead for the safety guarantee. The next efficiency
work should reduce that overhead through event-driven invalidation, batching
and coalescing, then rerun the same frozen workload.

These figures do **not** support claims such as “80% fewer requests”, real
provider cost reduction, or production behavior across arbitrary connectors.
The raw traces and anonymized packet were generated under `.tmp/` and are not
part of the public source tree.
