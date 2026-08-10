import assert from "node:assert/strict";
import { HybridIndex } from "../dist/index.js";

const index = new HybridIndex({
  lexicalWeight: 1,
  vectorWeight: 0,
  vectorProvider: { name: "latency-test-provider", mode: "external", embed: () => [1] }
});

for (let number = 0; number < 25_000; number += 1) {
  await index.add({
    id: `latency:${String(number).padStart(5, "0")}`,
    text: `production query latency fixture document ${number % 19}`,
    metadata: { tenantId: `tenant:${number % 4}`, acl: "reader", freshness: "fresh" }
  });
}

const options = { limit: 10, filter: { tenantId: "tenant:2", acl: "reader", freshness: "fresh" } };
for (let number = 0; number < 3; number += 1) await index.search("production query latency", options);
const durations = [];
for (let number = 0; number < 12; number += 1) {
  const started = performance.now();
  const results = await index.search("production query latency", options);
  durations.push(performance.now() - started);
  assert.equal(results.length, 10);
}
durations.sort((left, right) => left - right);
const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? durations.at(-1) ?? 0;
assert.ok(p95 < 500, `25k-document top-k p95 was ${p95.toFixed(2)}ms`);

console.log(`index-hybrid latency test passed (p95=${p95.toFixed(2)}ms)`);
