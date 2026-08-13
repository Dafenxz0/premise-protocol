# Efficiency Lab v1 safety gates

Efficiency is evaluated only after all mandatory safety and equivalence gates
pass. The referee must not rank an ineligible candidate by work performed.

## Mandatory gates

```text
referenceEquivalent == PASS
affectedRecall == 1.0
unsafeActions == 0
toctouEscapes == 0
staleReceiptReuse == 0
crossTenantReuse == 0
unknownPromotedFresh == 0
invalidReceiptAccepted == 0
authorizationScopeViolations == 0
incarnationViolations == 0
replayViolations == 0
```

The campaign also requires:

```text
falseBlocks <= referenceFalseBlockCeiling
safeCompletion >= referenceSafeCompletionFloor
```

The ceilings and floors are frozen in the campaign manifest. They cannot be
chosen after observing candidate output.

## Ineligible states

A candidate is `INELIGIBLE` if:

- a required metric is missing;
- a holdout is partial;
- a provider or adapter error is represented as a successful action;
- a candidate receives forbidden oracle data;
- the candidate mapping is visible before examination;
- the minimum-work certificate is absent where the report claims WA;
- a counter is negative, non-integer or double-counted by the trace checker.

## Reference equivalence

`referenceEquivalent` is not shorthand for `unsafeActions == 0`. The
independent reference and the candidate must match all five fields:

```text
decision
coherence
frontier
guardDecision
actionOutcome
```

The report includes a per-field object. A single mismatch makes the candidate
ineligible, even when the final action happens to be the same.

## Ranking

Only eligible candidates are ordered by:

1. work per safe completion;
2. `WA_external`;
3. `WA_graph`;
4. `WA_validate`;
5. `WA_write`;
6. physical operation count;
7. latency;
8. deterministic `blindId` tie-break.

This order is normative and is duplicated in the blind referee contract tests.

Blocking every action is not a valid optimization. A candidate with no safe
completion is never eligible, even if its work is zero.
