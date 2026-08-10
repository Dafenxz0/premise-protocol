# `@premise/index-hybrid`

Small, dependency-free, in-memory hybrid retrieval for Node.js.

```ts
import { HybridIndex } from "@premise/index-hybrid";

const index = new HybridIndex();
await index.upsert({
  id: "memory:42",
  text: "The release is blocked by a failing integration test",
  metadata: { project: "premise", status: "blocked" }
});

const results = await index.search("failing integration", {
  filter: { project: "premise", status: "blocked" },
  limit: 5
});
```

The index calculates BM25 over tokens and cosine similarity from an injected
`VectorProvider`, then combines both scores with configurable non-negative
weights. Results use a fixed tie-break (`score`, lexical score, vector score,
then id) and include `explanation.reasons` plus the component scores.

`LocalFallbackVectorProvider` is the default provider. It creates a
deterministic token-hash vector so the package works without network access.
That vector is a lexical fallback; it is not a semantic embedding and should
not be presented as one. For semantic embeddings, inject an external provider:

```ts
const index = new HybridIndex({
  vectorProvider: {
    name: "my-embedding-service",
    mode: "external",
    async embed(text) {
      return await embedWithMyService(text);
    }
  }
});
```

Metadata filters accept direct equality and `$eq`, `$ne`, `$in`, `$nin`,
`$exists`, numeric range operators, `$contains`, and `$prefix`. A predicate can
be supplied when a structured filter is not enough. `upsert` creates or
replaces a document, `update` requires an existing id, and `delete` removes it.
