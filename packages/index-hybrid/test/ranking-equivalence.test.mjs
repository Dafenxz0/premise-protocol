import assert from "node:assert/strict";
import { HybridIndex } from "../dist/index.js";

const provider = {
  name: "equivalence-provider",
  mode: "external",
  embed(text) {
    let hash = 2166136261;
    for (const character of text) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return [text.includes("anchor") ? 1 : 0.25, (hash % 97) / 97, 1];
  }
};

const index = new HybridIndex({ vectorProvider: provider, lexicalWeight: 0.7, vectorWeight: 0.3 });
const documents = Array.from({ length: 1_200 }, (_, number) => ({
  id: `equivalence:${String(number).padStart(4, "0")}`,
  text: `anchor ${number % 11 === 0 ? "priority" : "background"} topic-${number % 13} shard-${number % 7}`,
  metadata: {
    tenantId: `tenant:${number % 4}`,
    acl: number % 5 === 0 ? "restricted" : "reader",
    freshness: number % 7 === 0 ? "stale" : "fresh",
    ordinal: number
  },
  content: { number }
}));

for (const document of documents) await index.add(document);

const scenarios = [
  {
    query: "anchor priority",
    options: {
      lexicalWeight: 0.7,
      vectorWeight: 0.3,
      minScore: 0.05,
      filter: { tenantId: "tenant:2", acl: "reader", freshness: "fresh" }
    }
  },
  {
    query: "anchor background",
    options: { lexicalWeight: 0, vectorWeight: 1, limit: 10 }
  },
  {
    query: "anchor topic-3",
    options: {
      lexicalWeight: 1,
      vectorWeight: 0,
      filter: (metadata) => metadata?.tenantId === "tenant:1" && metadata?.acl === "reader"
    }
  }
];

for (const scenario of scenarios) {
  const full = await index.search(scenario.query, { ...scenario.options, limit: documents.length });
  assert.ok(full.length > 0, `scenario produced no results: ${scenario.query}`);
  for (const limit of [1, 2, 7, 41, 257, documents.length + 10]) {
    const limited = await index.search(scenario.query, { ...scenario.options, limit });
    assert.deepEqual(limited, full.slice(0, limit), `top-k mismatch for ${scenario.query} at limit ${limit}`);
  }
}

const tieIndex = new HybridIndex({
  vectorProvider: { name: "tie-equivalence-provider", mode: "external", embed: () => [1, 0] },
  lexicalWeight: 0,
  vectorWeight: 1
});
for (const id of ["tie:z", "tie:c", "tie:a", "tie:b", "tie:y", "tie:x"]) await tieIndex.add({ id, text: "identical" });
const tieFull = await tieIndex.search("different", { limit: 6, minScore: 0.5 });
assert.deepEqual(tieFull.map(({ id }) => id), ["tie:a", "tie:b", "tie:c", "tie:x", "tie:y", "tie:z"]);
for (const limit of [1, 2, 3, 6]) {
  const limited = await tieIndex.search("different", { limit, minScore: 0.5 });
  assert.deepEqual(limited, tieFull.slice(0, limit), `tie top-k mismatch at limit ${limit}`);
}

console.log("index-hybrid ranking equivalence tests passed");
