# Efficiency Lab v1 oracle computation model

This document freezes what counts as work before an optimizer or a holdout is
run. It is part of the preregistration. An implementation may use indexes,
memoization or maintained state, but the work needed to build and update that
state is charged to the mutation that caused it.

## Hypotheses

```text
For a fixed safety/coherence outcome, runtime work scales with the relevant
change blast radius rather than with the total dependency graph.

When relevant_change << total_graph, incremental PREMiSE requires less graph
work than a full/reference traversal while producing identical normative
decisions, frontier and action outcome.
```

The v1 claims are limited to physical runtime operations, graph work,
external work, validation work and writes. Tokens, provider billing and
commercial savings are outside this model.

## Primitive operation costs

| Dimension | One counted operation |
| --- | --- |
| graph | node lookup, edge traversal, reverse-index lookup, frontier lookup, or dirty-state update |
| external | source read, conditional read, authoritative read, or one physical batch request |
| validation | one validator invocation or one continuity/revalidation operation |
| write | one write intent or CAS attempt, including a rejected CAS |

Returned items in a batch are recorded separately, but they do not become
additional physical requests. Local cache hits and index lookups remain
protocol work even when they do not touch an external source.

## Query and maintenance work

Every report must keep these quantities separate:

```text
WA_query       work needed to answer the current action
WA_maintenance work caused by processing mutations and maintaining indexes
WA_total       WA_query + WA_maintenance
```

Precomputed state is never free. A query may be O(1) after an index is
maintained, but the index update is charged to maintenance work and its
counters must be present in the trace.

## Certified minima

The oracle may emit `EXACT`, `CERTIFIED_LOWER_BOUND`, `UNKNOWN` or
`UNBOUNDED`. An exact minimum requires complete legal-plan enumeration. A
scalable run may use only a documented lower bound. Zero and unavailable
denominators never become a one-operation denominator by convention.

## Complexity vocabulary

These are implementation descriptions, not marketing claims:

```text
full/reference traversal:              O(V + E)
incremental dirty propagation:         O(V_affected + E_affected)
maintained frontier lookup:             O(F) for F returned roots
validated cache hit:                    O(1) expected local lookup
```

The asymptotic description is valid only when index construction and
maintenance are included in the corresponding mutation work.
