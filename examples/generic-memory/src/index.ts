import { ReferenceProtocol } from "@premise/reference-ts";
import type { CapabilitiesDeclaration, MemoryEnvelope, PremiseEvent, ValidationResult } from "@premise/protocol-types";

export interface GenericMemoryRecord<T = unknown> {
  readonly memoryId: string;
  readonly content: T;
  readonly envelope: MemoryEnvelope;
}

export class GenericMemoryAdapter<T = unknown> {
  readonly protocol = new ReferenceProtocol();
  readonly capabilities: CapabilitiesDeclaration = { specVersion: "premise/0.1", capabilities: ["RECORD", "DEPENDENCY", "REVALIDATION", "RETRIEVAL", "GATE"], profile: "PREMiSE-compatible v0.1" };
  private readonly records = new Map<string, GenericMemoryRecord<T>>();

  register(record: GenericMemoryRecord<T>): void { if (record.memoryId !== record.envelope.memoryId) throw new Error("Memory record and envelope IDs must match"); this.protocol.register(record.envelope); this.records.set(record.memoryId, record); }
  derive(record: GenericMemoryRecord<T>): void { if (record.memoryId !== record.envelope.memoryId) throw new Error("Memory record and envelope IDs must match"); this.protocol.derive(record.envelope); this.records.set(record.memoryId, record); }
  signal(event: PremiseEvent): ReturnType<ReferenceProtocol["signal"]> { if (event.type !== "SourceChanged") throw new Error("Only SourceChanged is supported"); return this.protocol.signal(event as Parameters<ReferenceProtocol["signal"]>[0]); }
  validate(memoryIds: readonly string[], results?: Readonly<Record<string, ValidationResult>>) { return this.protocol.validate(memoryIds, results); }
  check(memoryIds: readonly string[]) { return this.protocol.check(memoryIds).items; }
  history(memoryId: string) { return this.protocol.history(memoryId); }
  contentOf(memoryId: string): T | undefined { return this.records.get(memoryId)?.content; }
}

export async function runGenericExample(): Promise<{ readonly status: string; readonly content: unknown }> {
  const at = "2026-08-09T19:20:00Z";
  const envelope = { specVersion: "premise/0.1" as const, memoryId: "memory:generic", provenance: [{ sourceUri: "generic://fact", observedAt: at, version: { scheme: "demo", token: "v1" }, validator: { id: "demo", operation: "read" } }], validity: { status: "FRESH" as const, checkedAt: at, policy: "VERSIONED" as const }, dependsOn: [] };
  const adapter = new GenericMemoryAdapter();
  adapter.register({ memoryId: envelope.memoryId, content: { answer: 42 }, envelope });
  adapter.signal({ specVersion: "premise/0.1", eventId: "generic-change", type: "SourceChanged", occurredAt: at, payload: { sourceUri: "generic://fact", version: { scheme: "demo", token: "v2" } } });
  await adapter.validate([envelope.memoryId], { [envelope.memoryId]: { memoryId: envelope.memoryId, result: "UNCHANGED", status: "FRESH", checkedAt: at, version: { scheme: "demo", token: "v2" } } });
  return { status: adapter.check([envelope.memoryId])[0]?.status ?? "UNKNOWN", content: adapter.contentOf(envelope.memoryId) };
}
