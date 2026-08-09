import {
  parseMemoryEnvelope,
  usabilityForStatus,
  type MemoryEnvelope,
  type MemoryStatus,
  type UsabilityDecision
} from "@premise/protocol-types";
import { DependencyCycleError, DependencyGraph } from "../graph/index.js";

export interface MemoryState {
  readonly memoryId: string;
  readonly envelope: MemoryEnvelope;
  readonly status: MemoryStatus;
}

export interface UsabilityReportItem {
  readonly memoryId: string;
  readonly status: MemoryStatus;
  readonly decision: UsabilityDecision;
}

export function aggregateDependencyStatuses(statuses: readonly MemoryStatus[]): MemoryStatus {
  if (statuses.includes("INVALID")) return "INVALID";
  if (statuses.includes("UNKNOWN")) return "UNKNOWN";
  if (statuses.includes("STALE")) return "STALE";
  return "FRESH";
}

export class MemoryStateStore {
  readonly graph = new DependencyGraph();
  private readonly records = new Map<string, { envelope: MemoryEnvelope; baseStatus: MemoryStatus; status: MemoryStatus }>();

  register(input: unknown): MemoryState {
    const envelope = parseMemoryEnvelope(input);
    if (this.records.has(envelope.memoryId)) throw new Error(`Memory already registered: ${envelope.memoryId}`);
    if (envelope.dependsOn.length > 0) throw new Error("Use derive() for envelopes with dependencies");
    this.graph.addNode(envelope.memoryId);
    const record = { envelope, baseStatus: envelope.validity.status, status: envelope.validity.status };
    this.records.set(envelope.memoryId, record);
    return this.stateOf(envelope.memoryId)!;
  }

  derive(input: unknown): MemoryState {
    const envelope = parseMemoryEnvelope(input);
    if (this.records.has(envelope.memoryId)) throw new Error(`Memory already registered: ${envelope.memoryId}`);
    if (envelope.dependsOn.length === 0) throw new Error("derive() requires at least one dependency");
    if (envelope.dependsOn.includes(envelope.memoryId)) throw new DependencyCycleError(envelope.memoryId, envelope.memoryId);
    for (const dependencyId of envelope.dependsOn) if (!this.records.has(dependencyId)) throw new Error(`Unknown dependency: ${dependencyId}`);
    this.graph.setDependencies(envelope.memoryId, envelope.dependsOn);
    const record = { envelope, baseStatus: envelope.validity.status, status: envelope.validity.status };
    this.records.set(envelope.memoryId, record);
    this.recompute(envelope.memoryId);
    return this.stateOf(envelope.memoryId)!;
  }

  markStatus(memoryId: string, status: MemoryStatus): readonly MemoryState[] {
    const record = this.records.get(memoryId);
    if (!record) throw new Error(`Unknown memory: ${memoryId}`);
    record.baseStatus = status;
    this.recompute(memoryId);
    const affected = [memoryId, ...this.graph.reachableDependents(memoryId)];
    for (const dependentId of affected.slice(1)) this.recompute(dependentId);
    return affected.map((id) => this.stateOf(id)!);
  }

  stateOf(memoryId: string): MemoryState | undefined {
    const record = this.records.get(memoryId);
    return record ? { memoryId, envelope: record.envelope, status: record.status } : undefined;
  }

  states(): readonly MemoryState[] {
    return [...this.records.keys()].sort().map((memoryId) => this.stateOf(memoryId)!);
  }

  check(memoryIds: readonly string[]): readonly UsabilityReportItem[] {
    return memoryIds.map((memoryId) => {
      const state = this.stateOf(memoryId);
      if (!state) throw new Error(`Unknown memory: ${memoryId}`);
      return { memoryId, status: state.status, decision: usabilityForStatus(state.status) };
    });
  }

  private recompute(memoryId: string): void {
    const record = this.records.get(memoryId);
    if (!record) return;
    const dependencyStatuses = this.graph.dependenciesOf(memoryId).map((id) => this.records.get(id)?.status ?? "UNKNOWN");
    record.status = aggregateDependencyStatuses([record.baseStatus, ...dependencyStatuses]);
  }
}
