import assert from "node:assert/strict";
import { DependencyCycleError, MemoryStateStore } from "../dist/index.js";

const at = "2026-08-09T19:20:00Z";
const envelope = (memoryId, status = "FRESH", dependsOn = []) => ({
  specVersion: "premise/0.1",
  memoryId,
  validity: { status, checkedAt: "2026-08-09T19:20:00Z", policy: "MANUAL" },
  dependsOn,
  ...(dependsOn.length === 0 ? { provenance: [{ sourceUri: `memory://${memoryId}`, observedAt: "2026-08-09T19:20:00Z" }] } : {})
});

const store = new MemoryStateStore();
store.register(envelope("a"));
store.register(envelope("x"));
store.derive(envelope("b", "FRESH", ["a"]));
store.derive(envelope("c", "FRESH", ["b"]));
assert.equal(store.stateOf("c").status, "FRESH");
store.markStatus("a", "INVALID");
assert.equal(store.stateOf("b").status, "INVALID");
assert.equal(store.stateOf("c").status, "INVALID");
assert.equal(store.stateOf("x").status, "FRESH");
assert.equal(store.check(["c"])[0].decision, "REJECT");
assert.throws(() => store.derive(envelope("a2", "FRESH", ["a2"])), DependencyCycleError);
const ordered = new MemoryStateStore();
ordered.register(envelope("root"));
ordered.derive(envelope("z", "FRESH", ["root"]));
ordered.derive(envelope("a", "FRESH", ["z"]));
ordered.markStatus("root", "INVALID");
assert.equal(ordered.stateOf("a").status, "INVALID");
ordered.markStatus("root", "FRESH");
assert.equal(ordered.stateOf("root").status, "INVALID");
ordered.replace(envelope("root"));
assert.equal(ordered.stateOf("a").status, "FRESH");
const repeated = new MemoryStateStore();
repeated.register(envelope("repeat-root"));
repeated.derive(envelope("repeat-child", "FRESH", ["repeat-root"]));
repeated.markStatus("repeat-root", "STALE");
assert.deepEqual(
  repeated.markStatusWithPrevious("repeat-root", "STALE").map(({ state, previousStatus }) => [state.memoryId, previousStatus, state.status]),
  [["repeat-child", "STALE", "STALE"], ["repeat-root", "STALE", "STALE"]]
);
repeated.markStatus("repeat-root", "FRESH");
assert.equal(repeated.stateOf("repeat-child").status, "FRESH");
const batched = new MemoryStateStore();
batched.register(envelope("batch-a"));
batched.register(envelope("batch-b"));
batched.derive(envelope("batch-a-child", "FRESH", ["batch-a"]));
batched.derive(envelope("batch-b-child", "FRESH", ["batch-b"]));
const batchChanges = batched.markStatusesWithPrevious(["batch-a", "batch-b"], "STALE");
assert.deepEqual(batchChanges.map(({ state }) => state.memoryId), ["batch-a", "batch-a-child", "batch-b", "batch-b-child"]);
assert.deepEqual(batched.check(["batch-a-child", "batch-b-child"]).map((item) => item.decision), ["REVALIDATE", "REVALIDATE"]);
let now = "2026-08-09T19:20:00Z";
const ttl = new MemoryStateStore(() => now);
ttl.register({ ...envelope("ttl"), validity: { status: "FRESH", checkedAt: at, policy: "TTL", expiresAt: "2026-08-09T20:00:00Z" } });
assert.equal(ttl.check(["ttl"])[0].decision, "USABLE");
now = "2026-08-09T20:00:00Z";
assert.equal(ttl.check(["ttl"])[0].decision, "REVALIDATE");
console.log("reference-ts state tests passed");
