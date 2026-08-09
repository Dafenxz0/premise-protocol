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

export interface StatusChange {
  readonly state: MemoryState;
  readonly previousStatus: MemoryStatus;
}

export type Clock = () => string;

export function aggregateDependencyStatuses(statuses: readonly MemoryStatus[]): MemoryStatus {
  let aggregate: MemoryStatus = "FRESH";
  for (const status of statuses) {
    if (status === "INVALID") return "INVALID";
    if (status === "UNKNOWN") aggregate = "UNKNOWN";
    else if (status === "STALE" && aggregate === "FRESH") aggregate = "STALE";
  }
  return aggregate;
}

interface StateRecord {
  envelope: MemoryEnvelope;
  baseStatus: MemoryStatus;
  status: MemoryStatus;
  directlyInvalid: boolean;
  ttlExpired: boolean;
  expiresAtMs: number | undefined;
}

function createRecord(envelope: MemoryEnvelope): StateRecord {
  const expiresAt = envelope.validity.policy === "TTL" ? envelope.validity.expiresAt : undefined;
  return {
    envelope,
    baseStatus: envelope.validity.status,
    status: envelope.validity.status,
    directlyInvalid: envelope.validity.status === "INVALID",
    ttlExpired: false,
    expiresAtMs: expiresAt === undefined ? undefined : Date.parse(expiresAt)
  };
}

export class MemoryStateStore {
  readonly graph = new DependencyGraph();
  private readonly records = new Map<string, StateRecord>();
  private readonly sourceIndex = new Map<string, Set<string>>();

  constructor(readonly now: Clock = () => new Date().toISOString()) {}

  register(input: unknown): MemoryState {
    const envelope = parseMemoryEnvelope(input);
    const existing = this.records.get(envelope.memoryId);
    if (existing) {
      if (JSON.stringify(existing.envelope) === JSON.stringify(envelope)) return this.stateOf(envelope.memoryId)!;
      throw new Error(`Memory already registered: ${envelope.memoryId}`);
    }
    if (envelope.dependsOn.length > 0) throw new Error("Use derive() for envelopes with dependencies");
    this.graph.addNode(envelope.memoryId);
    this.records.set(envelope.memoryId, createRecord(envelope));
    this.indexSources(envelope);
    return this.stateOf(envelope.memoryId)!;
  }

  derive(input: unknown): MemoryState {
    const envelope = parseMemoryEnvelope(input);
    if (this.records.has(envelope.memoryId)) throw new Error(`Memory already registered: ${envelope.memoryId}`);
    if (envelope.dependsOn.length === 0) throw new Error("derive() requires at least one dependency");
    if (envelope.dependsOn.includes(envelope.memoryId)) throw new DependencyCycleError(envelope.memoryId, envelope.memoryId);
    for (const dependencyId of envelope.dependsOn) if (!this.records.has(dependencyId)) throw new Error(`Unknown dependency: ${dependencyId}`);
    this.graph.setDependencies(envelope.memoryId, envelope.dependsOn);
    this.records.set(envelope.memoryId, createRecord(envelope));
    this.indexSources(envelope);
    this.recompute(envelope.memoryId, this.nowFor([envelope.memoryId]));
    return this.stateOf(envelope.memoryId)!;
  }

  replace(input: unknown): MemoryState {
    const envelope = parseMemoryEnvelope(input);
    const current = this.records.get(envelope.memoryId);
    if (!current) throw new Error(`Unknown memory: ${envelope.memoryId}`);
    if (envelope.dependsOn.length === 0) this.graph.setDependencies(envelope.memoryId, []);
    else {
      for (const dependencyId of envelope.dependsOn) if (!this.records.has(dependencyId)) throw new Error(`Unknown dependency: ${dependencyId}`);
      this.graph.setDependencies(envelope.memoryId, envelope.dependsOn);
    }
    this.unindexSources(current.envelope);
    current.envelope = envelope;
    current.baseStatus = envelope.validity.status;
    current.directlyInvalid = envelope.validity.status === "INVALID";
    current.ttlExpired = false;
    current.expiresAtMs = envelope.validity.policy === "TTL" && envelope.validity.expiresAt !== undefined ? Date.parse(envelope.validity.expiresAt) : undefined;
    this.indexSources(envelope);
    this.recomputeAffected(envelope.memoryId);
    return this.stateOf(envelope.memoryId)!;
  }

  markStatus(memoryId: string, status: MemoryStatus): readonly MemoryState[] {
    return this.markStatusWithPrevious(memoryId, status).map(({ state }) => state);
  }

  markStatusWithPrevious(memoryId: string, status: MemoryStatus): readonly StatusChange[] {
    const record = this.records.get(memoryId);
    if (!record) throw new Error(`Unknown memory: ${memoryId}`);
    if (record.directlyInvalid && status !== "INVALID") status = "INVALID";
    record.baseStatus = status;
    if (status === "INVALID") record.directlyInvalid = true;
    const affected = this.collectDependents([memoryId]);
    const previous = new Map<string, MemoryStatus>();
    for (const id of affected) previous.set(id, this.records.get(id)!.status);
    this.recomputeSet(affected, this.nowFor(affected));
    return [...affected].sort().map((id) => ({ state: this.stateOf(id)!, previousStatus: previous.get(id)! }));
  }

  stateOf(memoryId: string): MemoryState | undefined {
    const record = this.records.get(memoryId);
    return record ? { memoryId, envelope: record.envelope, status: record.status } : undefined;
  }

  states(): readonly MemoryState[] {
    return [...this.records.keys()].sort().map((memoryId) => this.stateOf(memoryId)!);
  }

  memoryIdsForSource(sourceUri: string): readonly string[] {
    return [...(this.sourceIndex.get(sourceUri) ?? [])].sort();
  }

  check(memoryIds: readonly string[]): readonly UsabilityReportItem[] {
    for (const memoryId of memoryIds) if (!this.records.has(memoryId)) throw new Error(`Unknown memory: ${memoryId}`);
    const dependencyClosure = this.collectDependencies(memoryIds);
    const nowMs = this.nowFor(dependencyClosure);
    if (nowMs !== undefined) {
      const expired = [] as string[];
      for (const memoryId of dependencyClosure) {
        const record = this.records.get(memoryId)!;
        if (record.envelope.validity.policy !== "TTL") continue;
        const nextExpired = record.expiresAtMs !== undefined && nowMs >= record.expiresAtMs;
        if (record.ttlExpired !== nextExpired) {
          record.ttlExpired = nextExpired;
          expired.push(memoryId);
        }
      }
      if (expired.length > 0) this.recomputeSet(this.collectDependents(expired), nowMs);
    }
    return memoryIds.map((memoryId) => {
      const state = this.stateOf(memoryId)!;
      return { memoryId, status: state.status, decision: usabilityForStatus(state.status) };
    });
  }

  private recompute(memoryId: string, nowMs?: number): void {
    const record = this.records.get(memoryId);
    if (!record) return;
    if (record.envelope.validity.policy === "TTL") {
      const currentNow = nowMs ?? Date.parse(this.now());
      record.ttlExpired = record.expiresAtMs !== undefined && currentNow >= record.expiresAtMs;
    }
    let status: MemoryStatus = record.directlyInvalid ? "INVALID" : record.ttlExpired && record.baseStatus === "FRESH" ? "STALE" : record.baseStatus;
    if (status !== "INVALID") {
      for (const dependencyId of this.graph.dependenciesOf(memoryId)) {
        const dependencyStatus = this.records.get(dependencyId)?.status ?? "UNKNOWN";
        if (dependencyStatus === "INVALID") {
          status = "INVALID";
          break;
        }
        if (dependencyStatus === "UNKNOWN") status = "UNKNOWN";
        else if (dependencyStatus === "STALE" && status === "FRESH") status = "STALE";
      }
    }
    record.status = status;
  }

  private recomputeAffected(memoryId: string): readonly MemoryState[] {
    const affected = this.collectDependents([memoryId]);
    this.recomputeSet(affected, this.nowFor(affected));
    return [...affected].sort().map((id) => this.stateOf(id)!);
  }

  private collectDependents(memoryIds: readonly string[]): Set<string> {
    const affected = new Set<string>();
    const queue = [...memoryIds];
    for (const memoryId of queue) affected.add(memoryId);
    for (let index = 0; index < queue.length; index += 1) {
      for (const dependentId of this.graph.dependentsOf(queue[index]!)) {
        if (affected.has(dependentId)) continue;
        affected.add(dependentId);
        queue.push(dependentId);
      }
    }
    return affected;
  }

  private collectDependencies(memoryIds: readonly string[]): Set<string> {
    const closure = new Set<string>();
    const queue = [...memoryIds];
    for (const memoryId of queue) closure.add(memoryId);
    for (let index = 0; index < queue.length; index += 1) {
      for (const dependencyId of this.graph.dependenciesOf(queue[index]!)) {
        if (closure.has(dependencyId)) continue;
        closure.add(dependencyId);
        queue.push(dependencyId);
      }
    }
    return closure;
  }

  private recomputeSet(memoryIds: ReadonlySet<string>, nowMs: number | undefined): void {
    if (memoryIds.size === 0) return;
    const pending = new Map<string, number>();
    const queue: string[] = [];
    for (const memoryId of memoryIds) {
      let dependencyCount = 0;
      for (const dependencyId of this.graph.dependenciesOf(memoryId)) if (memoryIds.has(dependencyId)) dependencyCount += 1;
      pending.set(memoryId, dependencyCount);
      if (dependencyCount === 0) queue.push(memoryId);
    }
    let processed = 0;
    for (let index = 0; index < queue.length; index += 1) {
      const memoryId = queue[index]!;
      this.recompute(memoryId, nowMs);
      processed += 1;
      for (const dependentId of this.graph.dependentsOf(memoryId)) {
        const dependencyCount = pending.get(dependentId);
        if (dependencyCount === undefined) continue;
        const nextCount = dependencyCount - 1;
        pending.set(dependentId, nextCount);
        if (nextCount === 0) queue.push(dependentId);
      }
    }
    if (processed !== memoryIds.size) throw new Error("Dependency graph contains a cycle");
  }

  private nowFor(memoryIds: Iterable<string>): number | undefined {
    for (const memoryId of memoryIds) {
      if (this.records.get(memoryId)?.envelope.validity.policy === "TTL") return Date.parse(this.now());
    }
    return undefined;
  }

  private indexSources(envelope: MemoryEnvelope): void {
    for (const source of envelope.provenance ?? []) {
      const memoryIds = this.sourceIndex.get(source.sourceUri) ?? new Set<string>();
      memoryIds.add(envelope.memoryId);
      this.sourceIndex.set(source.sourceUri, memoryIds);
    }
  }

  private unindexSources(envelope: MemoryEnvelope): void {
    for (const source of envelope.provenance ?? []) {
      const memoryIds = this.sourceIndex.get(source.sourceUri);
      if (!memoryIds) continue;
      memoryIds.delete(envelope.memoryId);
      if (memoryIds.size === 0) this.sourceIndex.delete(source.sourceUri);
    }
  }
}
