import assert from "node:assert/strict";
import { DependencyCycleError, MemoryStateStore } from "../dist/index.js";

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
console.log("reference-ts state tests passed");
