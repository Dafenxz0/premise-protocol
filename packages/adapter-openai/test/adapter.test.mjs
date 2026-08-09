import assert from "node:assert/strict";
import { OpenAIMemoryAdapter } from "../dist/index.js";

const at = "2026-08-09T19:20:00Z";
const envelope = { specVersion: "premise/0.1", memoryId: "memory:openai", provenance: [{ sourceUri: "memory://openai", observedAt: at, version: { scheme: "test", token: "v1" }, validator: { id: "test", operation: "read" } }], validity: { status: "FRESH", checkedAt: at, policy: "VERSIONED" }, dependsOn: [] };
const adapter = new OpenAIMemoryAdapter();
const content = { answer: "keep me", nested: [1, 2] };
assert.throws(() => new OpenAIMemoryAdapter().register({ memoryId: "memory:wrong", content, envelope }), /IDs must match/);
adapter.register({ memoryId: envelope.memoryId, content, envelope });
assert.deepEqual(adapter.retrieve([envelope.memoryId])[0].content, content);
adapter.protocol.signal({ specVersion: "premise/0.1", eventId: "source-1", type: "SourceChanged", occurredAt: at, payload: { sourceUri: "memory://openai", version: { scheme: "test", token: "v2" } } });
assert.equal(adapter.retrieve([envelope.memoryId])[0].decision, "REVALIDATE");
assert.throws(() => adapter.gate([envelope.memoryId]));
await assert.rejects(() => adapter.revalidate([envelope.memoryId], { [envelope.memoryId]: { memoryId: "memory:other", result: "CHANGED", status: "INVALID", checkedAt: at, version: { scheme: "test", token: "v3" } } }), /Invalid validation result/);
await adapter.revalidate([envelope.memoryId], { [envelope.memoryId]: { memoryId: envelope.memoryId, result: "UNCHANGED", status: "FRESH", checkedAt: at, version: { scheme: "test", token: "v2" } } });
adapter.gate([envelope.memoryId]);
assert.deepEqual(adapter.contentOf(envelope.memoryId), content);
console.log("adapter-openai tests passed");
