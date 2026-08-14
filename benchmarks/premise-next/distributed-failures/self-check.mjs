import assert from "node:assert/strict";
import { DEFAULT_SEED, FORMAT, SCENARIO_IDS, runCampaign } from "./runner.mjs";

const first = await runCampaign({ seed: DEFAULT_SEED });
const second = await runCampaign({ seed: DEFAULT_SEED });

assert.deepEqual(first, second, "offline campaign output must be deterministic");
assert.equal(first.format, FORMAT);
assert.equal(first.mode, "offline-in-memory");
assert.deepEqual(first.execution, {
  adapter: "in-memory-postgres-adapter-double",
  processesRan: false,
  realPostgresRan: false,
  deterministic: true,
  credentialsRequiredForLive: true
});
assert.deepEqual(first.summary, { scenarioCount: 8, passed: 8, failed: 0 });
assert.deepEqual(first.scenarios.map((scenario) => scenario.id), SCENARIO_IDS);
assert.ok(first.scenarios.every((scenario) => scenario.status === "PASS"));

const result = (id) => first.scenarios.find((scenario) => scenario.id === id);
assert.equal(result("leader-crash-before-completion").observed.fault, "completion-skipped");
assert.equal(result("expiry-takeover").observed.replacementFence, 2);
assert.equal(result("old-leader-completion").observed.oldCompletion, "FENCED");
assert.equal(result("duplicate-completion").observed.duplicate, "FENCED");
assert.equal(result("aba-scope-change").observed.oldACompletion, "FENCED");
assert.deepEqual(result("tenant-isolation").observed.independentFences, [1, 1]);
assert.equal(result("follower-timeout-abort").observed.timeout, "TIMEOUT");
assert.equal(result("follower-timeout-abort").observed.abort, "TIMEOUT");
assert.equal(result("receipt-replay").observed.waitReplay, "COMPLETED");

await assert.rejects(
  () => runCampaign({ mode: "live", postgresUrl: "" }),
  /POSTGRES_URL.*offline fallback is used/u,
  "live mode must require an explicit URL"
);

console.log("distributed-failures self-check passed: 8 deterministic contract scenarios; processes=0 realPostgres=false");
