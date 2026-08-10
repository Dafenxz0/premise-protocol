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
if (result.mode === "live-github-readonly") {
  const direct = result.strategies.find((strategy) => strategy.strategy === "direct-read");
  assert.ok(direct, "live benchmark must include direct-read");
  assert.equal(direct.requests, result.tasks, "direct-read must perform one real GitHub request per task");
  assert.ok(direct.traces.every((trace) => Number.isInteger(trace.status) && trace.status >= 200 && trace.status < 400), "direct-read traces must include successful HTTP statuses");
}
console.log(`real-world-v2 self-check passed (${result.mode})`);
