import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const output = JSON.parse(await readFile(new URL("./results.json", import.meta.url), "utf8"));
assert.equal(output.benchmark, "giant-context-v2");
assert.ok(output.results.length > 0);
for (const row of output.results) {
  assert.ok(row.memories > 0);
  assert.ok(row.tokensUsed <= output.tokenBudget);
  assert.equal(row.targetSelected, true);
  assert.ok(row.p95Ms >= row.p50Ms);
  assert.equal(row.traceEntries, row.memories);
}
console.log(`giant-context-v2 self-check passed (${output.results.map((row) => row.memories).join(", ")})`);
