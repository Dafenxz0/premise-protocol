import assert from "node:assert/strict";
import test from "node:test";
import { shouldFlushDurableWrite } from "./route-durability.mjs";

test("flushes only PostgreSQL mutation routes", () => {
  assert.equal(shouldFlushDurableWrite("/v2/memories", "POST", "postgres"), true);
  assert.equal(shouldFlushDurableWrite("/v2/source-changed", "POST", "postgres"), true);
  assert.equal(shouldFlushDurableWrite("/v2/memories/memory%3A1/revalidate", "POST", "postgres"), true);
  assert.equal(shouldFlushDurableWrite("/v2/query", "POST", "postgres"), false);
  assert.equal(shouldFlushDurableWrite("/v2/capabilities", "GET", "postgres"), false);
  assert.equal(shouldFlushDurableWrite("/v2/memories", "POST", "memory"), false);
});

console.log("route durability tests passed");
