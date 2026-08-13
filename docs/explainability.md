# Explainability documents

`packages/runtime-core/src/explainability.ts` provides a pure formatter for a
decision and its receipt metadata. It produces a deterministic
`premise-explainability/1` `ExplanationDocument` with:

- the tenant-scoped `USE`, `REVALIDATE` or `REJECT` decision;
- the observed `FRESH`, `STALE`, `INVALID` or `UNKNOWN` state;
- stable reason codes, evidence IDs and opaque version references;
- dependency nodes and causal `DEPENDS_ON` edges;
- the declared policy and risk level, when supplied.

```ts
const explanation = createExplanationDocument({
  tenantId: "tenant:acme",
  memoryId: "memory:release",
  decision: "REVALIDATE",
  state: "STALE",
  policy: "VERSIONED",
  risk: "HIGH",
  reasonCodes: ["SOURCE_CHANGED"],
  evidence: [{
    evidenceId: "evidence:release",
    version: { scheme: "git", token: "commit-a" }
  }],
  dependencies: [{ memoryId: "memory:config", state: "FRESH" }]
});
```

The formatter sorts IDs, edges and reason codes and returns frozen objects, so
the same metadata yields the same JSON ordering. It validates the tenant on
the receipt, evidence and dependency inputs. A foreign tenant is rejected.

The document is metadata-only by construction. It copies no content, payload,
source URI, arbitrary receipt field or secret. `redaction: "PAYLOADS_OMITTED"`
records that boundary. Free-form receipt reasons are ignored; only
reason-code-shaped values are retained.

This is an explanation view, not a new policy engine: it does not recalculate,
authorize or improve the supplied decision. `UNKNOWN` remains `UNKNOWN`, even
when a caller supplies a `USE` decision. Causal edges report declared
dependencies; they do not prove that a dependency caused a source change.

## Limits

The document is not a cryptographic audit record and does not replace a
durable audit journal, signed receipt, authorization check or observability
log. It does not prove the truth of a payload, the identity of a connector or
the completeness of a dependency graph beyond the metadata supplied by the
caller.
