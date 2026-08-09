import { OpenAIMemoryAdapter } from "@premise/adapter-openai";

export async function runOpenAIMemoryExample(): Promise<{ readonly decision: string; readonly content: unknown }> {
  const at = "2026-08-09T19:20:00Z";
  const envelope = { specVersion: "premise/0.1" as const, memoryId: "memory:openai-example", provenance: [{ sourceUri: "openai://memory/fact", observedAt: at, version: { scheme: "demo", token: "v1" }, validator: { id: "demo", operation: "read" } }], validity: { status: "FRESH" as const, checkedAt: at, policy: "VERSIONED" as const }, dependsOn: [] };
  const adapter = new OpenAIMemoryAdapter();
  adapter.register({ memoryId: envelope.memoryId, content: { provider: "openai", fact: "stable" }, envelope });
  adapter.signal({ specVersion: "premise/0.1", eventId: "openai-change", type: "SourceChanged", occurredAt: at, payload: { sourceUri: "openai://memory/fact", version: { scheme: "demo", token: "v2" } } });
  const before = adapter.retrieve([envelope.memoryId])[0];
  if (!before) throw new Error("Example memory was not retrievable");
  await adapter.revalidate([envelope.memoryId], { [envelope.memoryId]: { memoryId: envelope.memoryId, result: "UNCHANGED", status: "FRESH", checkedAt: at, version: { scheme: "demo", token: "v2" } } });
  return { decision: before.decision, content: adapter.contentOf(envelope.memoryId) };
}
