import { ReferenceProtocol, type ValidationReport } from "@premise/reference-ts";
import type { CapabilitiesDeclaration, Capability, MemoryEnvelope } from "@premise/protocol-types";

export interface OpenAIMemoryRecord<T = unknown> {
  readonly memoryId: string;
  readonly content: T;
  readonly envelope: MemoryEnvelope;
}

export interface RetrievedMemory<T = unknown> {
  readonly memoryId: string;
  readonly content: T;
  readonly status: string;
  readonly decision: "USABLE" | "REVALIDATE";
}

export class OpenAIMemoryAdapter<T = unknown> {
  readonly protocol: ReferenceProtocol;
  readonly capabilities: CapabilitiesDeclaration = {
    specVersion: "premise/0.1",
    capabilities: ["RECORD", "DEPENDENCY", "REVALIDATION", "RETRIEVAL", "GATE"] as readonly Capability[],
    profile: "PREMiSE-compatible v0.1"
  };
  private readonly memories = new Map<string, OpenAIMemoryRecord<T>>();

  constructor(protocol = new ReferenceProtocol()) {
    this.protocol = protocol;
  }

  register(record: OpenAIMemoryRecord<T>): void {
    if (this.memories.has(record.memoryId)) throw new Error(`Memory already registered: ${record.memoryId}`);
    this.protocol.register(record.envelope);
    this.memories.set(record.memoryId, record);
  }

  derive(record: OpenAIMemoryRecord<T>): void {
    if (this.memories.has(record.memoryId)) throw new Error(`Memory already registered: ${record.memoryId}`);
    this.protocol.derive(record.envelope);
    this.memories.set(record.memoryId, record);
  }

  async revalidate(memoryIds: readonly string[], results?: Parameters<ReferenceProtocol["validate"]>[1]): Promise<ValidationReport> {
    return this.protocol.validate(memoryIds, results);
  }

  retrieve(memoryIds: readonly string[]): readonly RetrievedMemory<T>[] {
    const stateById = new Map(this.protocol.check(memoryIds).items.map((item) => [item.memoryId, item]));
    const result: RetrievedMemory<T>[] = [];
    for (const memoryId of memoryIds) {
      const record = this.memories.get(memoryId);
      const state = stateById.get(memoryId);
      if (!record || !state || state.decision === "REJECT") continue;
      result.push({ memoryId, content: record.content, status: state.status, decision: state.decision });
    }
    return result;
  }

  gate(memoryIds: readonly string[]): void {
    const report = this.protocol.check(memoryIds);
    const blocked = report.items.filter((item) => item.decision !== "USABLE").map((item) => `${item.memoryId}:${item.decision}`);
    if (blocked.length > 0) throw new Error(`PREMiSE gate blocked action: ${blocked.join(", ")}`);
  }

  contentOf(memoryId: string): T | undefined {
    return this.memories.get(memoryId)?.content;
  }
}
