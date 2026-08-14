import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("quickstart uses the Adapter SDK contract through PremiseSession", () => {
  const output = execFileSync(process.execPath, ["examples/quickstart.mjs"], {
    encoding: "utf8"
  }).trim();

  assert.deepEqual(JSON.parse(output), {
    adapter: "quickstart-memory",
    contract: "premise-adapter/2",
    decision: "USABLE",
    action: { action: { type: "publish" }, status: "action-committed" }
  });
});
