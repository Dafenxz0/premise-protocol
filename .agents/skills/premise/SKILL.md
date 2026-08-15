---
name: premise
description: Audit or implement PREMiSE coherence workflows for mutable external state. Use when a task mentions PREMiSE, premise/1, premise/2, PremiseSession, adapters, guarded actions, CAS, or an agent must check a source version before a consequential action; record evidence, revalidate, and fail closed on stale or unknown state.
---

# PREMiSE coherence workflow

Use this skill to structure the agent workflow around evidence freshness. The
skill is guidance for the agent; it is not a replacement for the PREMiSE
runtime, a database, retrieval engine, embedding service, or truth oracle.

## Select the exact contract

- Use premise/1 for its normative states and decisions.
- Use premise/2 with the selected public API and runtime behavior.
- Use premise-guard/1 or premise-policy/1 for receipts, CAS, idempotency,
  fencing, capabilities, or guarded side effects.
- Never merge state tables or decisions from different contracts silently.

## Decide whether it applies

Apply PREMiSE when all of these are true:

1. The task depends on external state that can change.
2. The agent may act later using what it observed.
3. Acting on an old observation could cause a wrong or unsafe result.

Do not add PREMiSE to immutable local calculations or to a task that only
explains already-provided text. For a high-risk action, use the runtime's
guarded or conditional-action API; do not rely on this instruction alone.

## Required workflow

1. Identify the source, tenant, resource, and incarnation. Do not use a human
   description as the identity of a resource.
2. Observe the source and record the evidence id, observed-at time, version
   scheme/token, validator, and relevant authorization or policy scope.
3. Derive dependent premises only from recorded evidence. Preserve dependency
   edges and the change-set or causal frontier when the public API supplies
   them.
4. Before answering a low-risk question, use the recorded evidence if its
   status is FRESH. Before a write, merge, delete, deploy, or permission
   change, call the runtime check or revalidation operation immediately before
   the action.
5. Treat STALE and INVALID as reasons to stop using the premise. Re-read and
   re-plan. Treat UNKNOWN, timeout, missing permissions, identity mismatch,
   incarnation change, and validator failure as fail-closed outcomes.
6. Perform the side effect only through a runtime/adapter conditional or
   guarded action that binds the action to the validated version and an
   idempotency key. A prompt, cache label, or check result is not CAS.
7. Preserve the receipt and explain which evidence, version, and decision
   authorized the result. Never claim that a cache hit proves freshness.

## Public integration boundary

For an external Node project, install @premise/sdk and use its public HTTP
client. Do not import packages/runtime-core, workspace aliases, dist files
from a checkout, or benchmark oracles. Follow the external integration
checklist in references/integration-checklist.md.

For protocol details and the boundary between agent guidance and runtime
enforcement, read references/protocol-boundary.md and
references/contract-map.md. Use references/evidence-and-claims.md when
reporting results and the bundled boundary check script when validating a
consumer fixture.

The public @premise/sdk client is read/query/revalidation oriented in this
release candidate; it does not expose a conditional side-effect operation.
Do not simulate a write in prose. If the chosen connector has no documented
CAS or guarded action, report the action as unsupported.

## Failure rules

- Never silently downgrade UNKNOWN to FRESH.
- Never retry a side effect without preserving its idempotency key.
- Never treat a check or revalidation result as atomic authorization unless
  the selected connector performs the conditional commit.
- Never reuse evidence across tenants, authorization scopes, policies, query
  families, incarnations, or change sets unless the runtime's canonical scope
  explicitly permits it.
- Never hide a skipped connector or unavailable credential as PASS.
- Never invent a receipt, action result, or production claim.
- Never expose secrets in evidence, logs, prompts, or reports.
