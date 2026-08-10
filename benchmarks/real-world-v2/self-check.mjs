import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const result = JSON.parse(await readFile(new URL("./results.json", import.meta.url), "utf8"));
assert.ok(result.mode === "offline-temporal-fixture" || result.mode === "live-github-readonly");
assert.ok(Number.isInteger(result.tasks) && result.tasks >= 100);
assert.ok(Array.isArray(result.strategies) && result.strategies.length >= 3);
for (const strategy of result.strategies) {
  assert.equal(strategy.tasks, result.tasks);
  assert.ok(strategy.correctPer100 >= 0 && strategy.correctPer100 <= 100);
  assert.ok(strategy.requestsPer100 >= 0);
  assert.ok(strategy.p95Ms >= strategy.p50Ms);
  assert.ok(Array.isArray(strategy.traces));
}
if (result.mode === "offline-temporal-fixture") {
  const premise = result.strategies.find((strategy) => strategy.strategy === "premise-event-cache");
  const ttl = result.strategies.find((strategy) => strategy.strategy === "ttl-cache-20");
  assert.ok(premise && ttl);
  assert.equal(premise.correctPer100, 100);
  assert.ok(ttl.correctPer100 < 100, "the TTL baseline must demonstrate temporal staleness in the fixture");
}
console.log(`real-world-v2 self-check passed (${result.mode})`);
