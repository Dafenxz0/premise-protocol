# PREMiSE Session API

`PremiseSession` is the small application-facing façade over the runtime. It
keeps adapters responsible for external I/O and remote conditional writes,
while the runtime owns evidence, dependencies, revalidation and fail-closed
action gating.

```ts
const session = premise.session({ tenant: "agent:acme", adapter });
const pr = await session.observe("github://acme/app/pr/42");
const ready = await session.derive({
  claim: "PR 42 is ready to merge",
  from: [pr]
});

if (session.check(ready).decision === "USABLE") {
  await session.act({ premise: ready, action: { type: "merge" } });
}
```

An adapter must provide only `observe`, `derive` and `revalidate`. It may add
`conditionalAction`; without that callback `session.act` refuses to execute
anything. The callback must perform the connector's own atomic CAS, so the
session API is not a substitute for GitHub, SQL or HTTP concurrency control.

The session validates tenant boundaries and dependency declarations. It does
not provide retrieval, embeddings, a vector database, an LLM, authentication,
or a universal truth oracle. It is an additive façade over the existing
runtime and does not change the lower-level API.
