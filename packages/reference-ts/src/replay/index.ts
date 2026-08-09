import { parseMemoryEnvelope } from "@premise/protocol-types";
import { parsePremiseEvent } from "../events/index.js";
import type { MemoryStatus, PremiseEvent } from "@premise/protocol-types";

export interface ReplayMemory {
  readonly memoryId: string;
  readonly status: MemoryStatus;
  readonly dependsOn: readonly string[];
}

export interface ReplaySnapshot {
  readonly memories: Readonly<Record<string, ReplayMemory>>;
  readonly history: Readonly<Record<string, readonly string[]>>;
  readonly eventCount: number;
}

function statusForResult(result: unknown): MemoryStatus {
  if (result === "UNCHANGED") return "FRESH";
  if (result === "CHANGED" || result === "MISSING") return "INVALID";
  return "UNKNOWN";
}

function aggregate(statuses: readonly MemoryStatus[]): MemoryStatus {
  if (statuses.includes("INVALID")) return "INVALID";
  if (statuses.includes("UNKNOWN")) return "UNKNOWN";
  if (statuses.includes("STALE")) return "STALE";
  return "FRESH";
}

export function replayEvents(inputs: readonly unknown[]): ReplaySnapshot {
  const memories = new Map<string, { direct: MemoryStatus; status: MemoryStatus; dependsOn: string[] }>();
  const history = new Map<string, string[]>();
  const eventIds = new Set<string>();
  const requireMemory = (memoryId: string): { direct: MemoryStatus; status: MemoryStatus; dependsOn: string[] } => {
    const memory = memories.get(memoryId);
    if (!memory) throw new Error(`Replay event references unknown memory: ${memoryId}`);
    return memory;
  };
  const recompute = (): void => {
    const remaining = new Set(memories.keys());
    const resolved = new Set<string>();
    while (remaining.size > 0) {
      const ready = [...remaining].filter((id) => memories.get(id)!.dependsOn.every((dependency) => resolved.has(dependency))).sort();
      if (ready.length === 0) throw new Error("Replay dependency graph contains a cycle or unknown dependency");
      for (const id of ready) {
        const memory = memories.get(id)!;
        memory.status = aggregate([memory.direct, ...memory.dependsOn.map((dependency) => memories.get(dependency)!.status)]);
        remaining.delete(id);
        resolved.add(id);
      }
    }
  };

  for (const input of inputs) {
    const event = parsePremiseEvent(input);
    if (eventIds.has(event.eventId)) throw new Error(`Duplicate replay eventId: ${event.eventId}`);
    eventIds.add(event.eventId);
    if (event.memoryId) {
      const ids = history.get(event.memoryId) ?? [];
      ids.push(event.eventId);
      history.set(event.memoryId, ids);
    }
    switch (event.type) {
      case "MemoryRegistered": {
        const envelope = parseMemoryEnvelope(event.payload.envelope);
        const current = memories.get(event.memoryId!);
        if (current && (current.direct !== envelope.validity.status || JSON.stringify(current.dependsOn) !== JSON.stringify(envelope.dependsOn))) throw new Error(`Conflicting replay registration: ${event.memoryId}`);
        memories.set(event.memoryId!, { direct: envelope.validity.status, status: envelope.validity.status, dependsOn: [...envelope.dependsOn] });
        break;
      }
      case "MemoryDerived": {
        const current = memories.get(event.memoryId!);
        const dependsOn = event.payload.dependsOn as unknown[];
        if (dependsOn.some((dependency) => typeof dependency !== "string" || !memories.has(dependency))) throw new Error(`Replay derived event has unknown dependency: ${event.memoryId}`);
        if (current && JSON.stringify(current.dependsOn) !== JSON.stringify(dependsOn)) throw new Error(`Conflicting replay derivation: ${event.memoryId}`);
        memories.set(event.memoryId!, { direct: current?.direct ?? "FRESH", status: current?.status ?? "FRESH", dependsOn: [...(dependsOn as string[])] });
        break;
      }
      case "MemoryStaled": {
        const current = requireMemory(event.memoryId!);
        if (current.direct !== "INVALID") current.direct = "STALE";
        break;
      }
      case "MemoryInvalidated": {
        const current = requireMemory(event.memoryId!);
        current.direct = "INVALID";
        break;
      }
      case "MemoryRevalidated": {
        const current = requireMemory(event.memoryId!);
        const next = statusForResult(event.payload.result);
        if (current.direct === "INVALID" && next !== "INVALID") break;
        current.direct = next;
        break;
      }
      case "MemoryReplaced": {
        const current = requireMemory(event.memoryId!);
        current.direct = "FRESH";
        break;
      }
      case "SourceChanged":
        break;
    }
    recompute();
  }
  const memoryRecord: Record<string, ReplayMemory> = {};
  for (const id of [...memories.keys()].sort()) {
    const memory = memories.get(id)!;
    memoryRecord[id] = { memoryId: id, status: memory.status, dependsOn: [...memory.dependsOn] };
  }
  const historyRecord: Record<string, readonly string[]> = {};
  for (const id of [...history.keys()].sort()) historyRecord[id] = [...history.get(id)!];
  return { memories: memoryRecord, history: historyRecord, eventCount: inputs.length };
}

export function replayDeterministically(inputs: readonly unknown[]): { readonly first: ReplaySnapshot; readonly second: ReplaySnapshot; readonly deterministic: boolean } {
  const first = replayEvents(inputs);
  const second = replayEvents(inputs);
  return { first, second, deterministic: JSON.stringify(first) === JSON.stringify(second) };
}
