import assert from "node:assert/strict";
import { GenericMemoryAdapter } from "../examples/generic-memory/dist/index.js";
import { OpenAIMemoryAdapter } from "../packages/adapter-openai/dist/index.js";

const at = "2026-08-09T19:20:00Z";
const envelope = { specVersion: "premise/0.1", memoryId: "memory:cross-adapter", provenance: [{ sourceUri: "cross://fact", observedAt: at, version: { scheme: "cross", token: "v1" }, validator: { id: "cross", operation: "read" } }], validity: { status: "FRESH", checkedAt: at, policy: "VERSIONED" }, dependsOn: [] };
const event = { specVersion: "premise/0.1", eventId: "cross-change", type: "SourceChanged", occurredAt: at, payload: { sourceUri: "cross://fact", version: { scheme: "cross", token: "v2" } } };
const resultFor = async (adapter) => {
  adapter.register({ memoryId: envelope.memoryId, content: { same: true }, envelope });
  const fresh = adapter.check([envelope.memoryId]);
  adapter.signal(event);
  const stale = adapter.check([envelope.memoryId]);
  await adapter.validate([envelope.memoryId], { [envelope.memoryId]: { memoryId: envelope.memoryId, result: "UNCHANGED", status: "FRESH", checkedAt: at, version: { scheme: "cross", token: "v2" } } });
  const repaired = adapter.check([envelope.memoryId]);
  return { fresh, stale, repaired, historyLength: adapter.history(envelope.memoryId).length };
};

const generic = await resultFor(new GenericMemoryAdapter());
const openai = await resultFor(new OpenAIMemoryAdapter());
assert.deepEqual(generic, openai);
assert.equal(generic.fresh[0].decision, "USABLE");
assert.equal(generic.stale[0].decision, "REVALIDATE");
assert.equal(generic.repaired[0].decision, "USABLE");
assert.ok(generic.historyLength >= 3);
console.log(JSON.stringify({ crossAdapter: "PASS", historyLength: generic.historyLength }));
