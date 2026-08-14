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

The preferred adapter is `PremiseAdapter` from `@premise/adapter-sdk`. Pass it
directly to `premise.session`; `PremiseSession` supplies the session tenant,
converts observations into runtime records, and owns local derivation. The
adapter keeps external I/O, revalidation and any remote conditional write.

```ts
import type { PremiseAdapter } from "@premise/adapter-sdk";
import { premise } from "@premise/runtime-core";

const adapter: PremiseAdapter<MyValue, MyAction, MyResult> = /* connector */;
const session = premise.session({ tenant: "agent:acme", adapter });
```

`PremiseSession` also accepts the previous runtime-record adapter shape for
compatibility: `observe(resource, { tenantId })`, `revalidate(evidence,
record)`, and optional `conditionalAction`. Its legacy `derive` method is no
longer called; derivation is always owned by the session.

An SDK adapter must return an observation for the requested tenant/resource,
including a non-empty evidence list and a version. `conditionalAction` is
optional; without it `session.act` refuses to execute anything. That callback
must perform the connector's own atomic CAS, so the session API is not a
substitute for GitHub, SQL or HTTP concurrency control.

The session validates tenant boundaries and dependency declarations. It does
not provide retrieval, embeddings, a vector database, an LLM, authentication,
or a universal truth oracle. It is an additive façade over the existing
runtime and does not change the lower-level API.
