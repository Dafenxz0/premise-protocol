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

const statusForResult: Record<string, MemoryStatus> = {
  UNCHANGED: "FRESH",
  CHANGED: "INVALID",
  MISSING: "INVALID",
  UNKNOWN: "UNKNOWN"
};

function statusOf(value: unknown, fallback: MemoryStatus): MemoryStatus {
  return value === "FRESH" || value === "STALE" || value === "INVALID" || value === "UNKNOWN" ? value : fallback;
}

export function replayEvents(inputs: readonly unknown[]): ReplaySnapshot {
  const memories = new Map<string, { status: MemoryStatus; dependsOn: string[] }>();
  const history = new Map<string, string[]>();
  for (const input of inputs) {
    const event = parsePremiseEvent(input);
    if (event.memoryId) {
      const ids = history.get(event.memoryId) ?? [];
      ids.push(event.eventId);
      history.set(event.memoryId, ids);
    }
    switch (event.type) {
      case "MemoryRegistered": {
        const envelope = event.payload.envelope as { validity?: { status?: unknown }; dependsOn?: unknown };
        memories.set(event.memoryId!, { status: statusOf(envelope?.validity?.status, "FRESH"), dependsOn: Array.isArray(envelope?.dependsOn) ? envelope.dependsOn.filter((id): id is string => typeof id === "string") : [] });
        break;
      }
      case "MemoryDerived": {
        const current = memories.get(event.memoryId!) ?? { status: "FRESH" as MemoryStatus, dependsOn: [] };
        current.dependsOn = Array.isArray(event.payload.dependsOn) ? event.payload.dependsOn.filter((id): id is string => typeof id === "string") : [];
        memories.set(event.memoryId!, current);
        break;
      }
      case "MemoryStaled": {
        const current = memories.get(event.memoryId!) ?? { status: "STALE" as MemoryStatus, dependsOn: [] };
        current.status = "STALE";
        memories.set(event.memoryId!, current);
        break;
      }
      case "MemoryInvalidated": {
        const current = memories.get(event.memoryId!) ?? { status: "INVALID" as MemoryStatus, dependsOn: [] };
        current.status = "INVALID";
        memories.set(event.memoryId!, current);
        break;
      }
      case "MemoryRevalidated": {
        const current = memories.get(event.memoryId!) ?? { status: "UNKNOWN" as MemoryStatus, dependsOn: [] };
        current.status = statusOf(event.payload.status, statusForResult[String(event.payload.result)] ?? "UNKNOWN");
        memories.set(event.memoryId!, current);
        break;
      }
      case "MemoryReplaced": {
        const current = memories.get(event.memoryId!) ?? { status: "INVALID" as MemoryStatus, dependsOn: [] };
        current.status = "INVALID";
        memories.set(event.memoryId!, current);
        break;
      }
      case "SourceChanged":
        break;
    }
  }
  const memoryRecord: Record<string, ReplayMemory> = {};
  for (const id of [...memories.keys()].sort()) memoryRecord[id] = { memoryId: id, status: memories.get(id)!.status, dependsOn: [...memories.get(id)!.dependsOn] };
  const historyRecord: Record<string, readonly string[]> = {};
  for (const id of [...history.keys()].sort()) historyRecord[id] = [...history.get(id)!];
  return { memories: memoryRecord, history: historyRecord, eventCount: inputs.length };
}

export function replayDeterministically(inputs: readonly unknown[]): { readonly first: ReplaySnapshot; readonly second: ReplaySnapshot; readonly deterministic: boolean } {
  const first = replayEvents(inputs);
  const second = replayEvents(inputs);
  return { first, second, deterministic: JSON.stringify(first) === JSON.stringify(second) };
}
