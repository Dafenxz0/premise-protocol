import assert from "node:assert/strict";
import { InMemoryRuntimeStore, PremiseRuntime } from "../dist/index.js";

const at = "2026-08-10T10:00:00Z";
const envelope = (memoryId, dependsOn = [], status = "FRESH") => ({
  specVersion: "premise/2",
  tenantId: "tenant:acme",
  memoryId,
  evidence: dependsOn.length === 0 ? [{ evidenceId: `${memoryId}:e`, sourceUri: "github://acme/repo/commit/main", observedAt: at, version: { scheme: "github.commit", token: "a1" }, validator: { id: "github", operation: "commit" } }] : [],
  confidence: { score: null, method: "test", assessedAt: at },
  conflicts: [],
  temporal: { asOf: at },
  validity: { status, checkedAt: at, policy: "MANUAL" },
  dependsOn,
  signatures: []
});

const runtime = new PremiseRuntime({ tenantId: "tenant:acme", now: () => at });
runtime.register({ envelope: envelope("memory:source"), content: { value: "source" } });
runtime.derive({ envelope: envelope("memory:derived", ["memory:source"]), content: { value: "derived" } });
assert.deepEqual(runtime.check(["memory:source", "memory:derived"]).map((item) => item.decision), ["USABLE", "USABLE"]);

const affected = runtime.signalSourceChanged("github://acme/repo/commit/main", { scheme: "github.commit", token: "b2" });
assert.deepEqual(affected, ["memory:source", "memory:derived"]);
assert.deepEqual(runtime.check(["memory:source", "memory:derived"]).map((item) => item.status), ["STALE", "STALE"]);

const report = await runtime.revalidate("memory:source", async (evidence) => ({ memoryId: "memory:source", evidenceId: evidence.evidenceId, result: "UNCHANGED", status: "FRESH", checkedAt: at, sourceUri: evidence.sourceUri, version: { scheme: "github.commit", token: "b2" } }));
assert.equal(report.status, "FRESH");
assert.equal(runtime.get("memory:source").content.value, "source");

const event = runtime.history("memory:source")[0];
assert.ok(event);
assert.equal(runtime.applyEvent(event), false);
assert.throws(() => runtime.register({ envelope: envelope("memory:source"), content: {} }), /already registered/);
assert.equal(runtime.get("memory:other", { tenantId: "tenant:other" }), undefined);

const snapshot = runtime.snapshot();
const restored = new PremiseRuntime({ store: new InMemoryRuntimeStore(), tenantId: "tenant:acme", now: () => at });
restored.restore(snapshot);
assert.equal(restored.get("memory:derived").content.value, "derived");
assert.equal(restored.history().length, runtime.history().length);

console.log("runtime-core tests passed");
