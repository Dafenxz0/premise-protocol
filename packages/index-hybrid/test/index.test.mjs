import assert from "node:assert/strict";
import { HybridIndex, LocalFallbackVectorProvider } from "../dist/index.js";

const documents = [
  { id: "doc:alpha", text: "Climate policy and renewable energy", metadata: { topic: "science", year: 2024, tags: ["climate", "energy"] }, content: { source: "alpha" } },
  { id: "doc:beta", text: "Climate risk assessment for coastal cities", metadata: { topic: "science", year: 2022, tags: ["climate", "risk"] }, content: { source: "beta" } },
  { id: "doc:gamma", text: "TypeScript build and package tooling", metadata: { topic: "engineering", year: 2024, tags: ["code"] }, content: { source: "gamma" } }
];

const lexical = new HybridIndex({ vectorWeight: 0 });
for (const document of documents) await lexical.add(document);

const quality = await lexical.search("renewable climate energy", { limit: 2 });
assert.equal(quality[0]?.id, "doc:alpha");
assert.ok((quality[0]?.lexicalScore ?? 0) > (quality[1]?.lexicalScore ?? 0));
assert.deepEqual(quality[0]?.explanation.lexical.queryTokens, ["renewable", "climate", "energy"]);
assert.deepEqual(quality[0]?.explanation.lexical.matchedTokens, ["renewable", "climate", "energy"]);
assert.match(quality[0]?.explanation.reasons.join(" ") ?? "", /BM25 matched tokens/);
assert.equal(quality[0]?.explanation.vector.used, false);

const filtered = await lexical.search("climate", { filter: { topic: "science", year: { $gte: 2023 }, tags: { $contains: "energy" } } });
assert.deepEqual(filtered.map((result) => result.id), ["doc:alpha"]);
assert.equal(filtered[0]?.explanation.metadata.filterApplied, true);
assert.equal((await lexical.search("tooling", { filter: { topic: { $in: ["science"] } } })).length, 0);
assert.equal((await lexical.search("tooling", { filter: { missing: { $exists: false } } }))[0]?.id, "doc:gamma");

const predicateMatches = await lexical.search("climate", { filters: (metadata) => metadata?.year === 2022 });
assert.deepEqual(predicateMatches.map((result) => result.id), ["doc:beta"]);

const providerCalls = [];
const provider = {
  name: "test-external-provider",
  mode: "external",
  async embed(text) {
    providerCalls.push(text);
    return text.includes("alpha") || text.includes("renewable") ? [1, 0] : [0, 1];
  }
};
const vectorIndex = new HybridIndex({ vectorProvider: provider, lexicalWeight: 0, vectorWeight: 1 });
await vectorIndex.add({ id: "a", text: "alpha", metadata: { group: "one" } });
await vectorIndex.add({ id: "b", text: "beta", metadata: { group: "two" } });
const vectorResults = await vectorIndex.search("renewable", { limit: 2 });
assert.equal(vectorResults[0]?.id, "a");
assert.equal(vectorResults[0]?.explanation.vector.provider, "test-external-provider");
assert.equal(vectorResults[0]?.explanation.vector.mode, "external");
assert.ok(providerCalls.includes("renewable"));

const tieIndex = new HybridIndex({
  vectorProvider: { name: "tie-provider", mode: "external", embed: () => [1, 0] },
  lexicalWeight: 0,
  vectorWeight: 1
});
await tieIndex.add({ id: "b", text: "one" });
await tieIndex.add({ id: "a", text: "two" });
assert.deepEqual((await tieIndex.search("anything")).map((result) => result.id), ["a", "b"]);
assert.equal((await tieIndex.search("anything"))[0]?.explanation.fusion.tieBreak, "score desc, lexical desc, vector desc, id asc");

const fallback = new HybridIndex({ vectorWeight: 1, lexicalWeight: 0 });
assert.equal(fallback.vectorProviderMode, "local-token-fallback");
await fallback.add({ id: "fallback", text: "same token" });
const fallbackResult = await fallback.search("same token");
assert.equal(fallbackResult[0]?.explanation.vector.mode, "local-token-fallback");
assert.match(fallbackResult[0]?.explanation.reasons.join(" ") ?? "", /not a semantic embedding/);

await lexical.update({ ...documents[2], text: "Climate tooling is now documented", metadata: { ...documents[2].metadata, topic: "science" } });
assert.equal(lexical.get("doc:gamma")?.text, "Climate tooling is now documented");
assert.equal((await lexical.search("documented", { filter: { topic: "science" } }))[0]?.id, "doc:gamma");
await assert.rejects(() => lexical.update({ id: "doc:missing", text: "missing" }), /missing document/);

assert.equal(lexical.delete("doc:beta"), true);
assert.equal(lexical.delete("doc:beta"), false);
assert.equal(lexical.get("doc:beta"), undefined);
assert.deepEqual((await lexical.search("coastal")).map((result) => result.id), []);
assert.equal(lexical.has("doc:alpha"), true);
lexical.clear();
assert.equal(lexical.size, 0);
assert.deepEqual(await lexical.search("climate"), []);

assert.throws(() => new LocalFallbackVectorProvider(0), /positive integer/);
assert.throws(() => new HybridIndex({ lexicalWeight: 0, vectorWeight: 0 }), /greater than zero/);
await assert.rejects(() => new HybridIndex({ vectorProvider: { embed: () => [Number.NaN] } }).add({ id: "bad", text: "bad" }), /non-finite/);

console.log("index-hybrid tests passed");
