import {
  SPEC_VERSION,
  type MemoryStatus,
  type SourceReference,
  type ValidationResult,
  type ValidatorResult,
  type VersionReference
} from "@premise/protocol-types";
import { EventJournal, eventForRegistration } from "../events/index.js";
import { MemoryStateStore, type UsabilityReportItem } from "../state/index.js";

export interface Validator {
  readonly id: string;
  validate(source: SourceReference): Promise<ValidationResult> | ValidationResult;
}

export interface ValidationReportItem {
  readonly memoryId: string;
  readonly result: ValidatorResult;
  readonly previousStatus: MemoryStatus;
  readonly status: MemoryStatus;
  readonly version?: VersionReference;
}

export interface ValidationReport {
  readonly items: readonly ValidationReportItem[];
  readonly eventIds: readonly string[];
}

export interface PropagationReport {
  readonly roots: readonly string[];
  readonly affected: readonly string[];
  readonly statuses: Readonly<Record<string, MemoryStatus>>;
}

export interface FrontierItem {
  readonly sourceUri: string;
  readonly observedAt: string;
  readonly version?: VersionReference;
  readonly validator?: { readonly id: string; readonly operation: string };
  readonly memoryIds: readonly string[];
}

export interface UsabilityReport {
  readonly items: readonly UsabilityReportItem[];
}

function statusForResult(result: ValidatorResult): MemoryStatus {
  if (result === "UNCHANGED") return "FRESH";
  if (result === "CHANGED" || result === "MISSING") return "INVALID";
  return "UNKNOWN";
}

function eventId(prefix: string, memoryId: string, sequence: number): string {
  return `${prefix}:${memoryId}:${sequence}`;
}

export class ReferenceProtocol {
  readonly states = new MemoryStateStore();
  readonly journal = new EventJournal();
  private readonly validators = new Map<string, Validator>();
  private sequence = 0;

  registerValidator(validator: Validator): void {
    this.validators.set(validator.id, validator);
  }

  register(envelope: unknown): void {
    const state = this.states.register(envelope);
    this.journal.append(eventForRegistration(state.envelope, eventId("registered", state.memoryId, this.sequence++), state.envelope.validity.checkedAt));
  }

  derive(envelope: unknown): void {
    const state = this.states.derive(envelope);
    this.journal.append({
      specVersion: SPEC_VERSION,
      eventId: eventId("derived", state.memoryId, this.sequence++),
      type: "MemoryDerived",
      occurredAt: state.envelope.validity.checkedAt,
      memoryId: state.memoryId,
      payload: { dependsOn: [...state.envelope.dependsOn] }
    });
  }

  signal(event: { readonly specVersion: typeof SPEC_VERSION; readonly eventId: string; readonly type: "SourceChanged"; readonly occurredAt: string; readonly payload: Readonly<Record<string, unknown>> }): PropagationReport {
    this.journal.append(event);
    const sourceUri = typeof event.payload.sourceUri === "string" ? event.payload.sourceUri : undefined;
    const roots = this.states.states().filter((state) => sourceUri !== undefined && state.envelope.provenance?.some((source) => source.sourceUri === sourceUri)).map((state) => state.memoryId);
    const affected = new Set<string>();
    for (const root of roots) {
      const before = new Map(this.states.states().map((state) => [state.memoryId, state.status]));
      const changed = this.states.markStatus(root, "STALE");
      for (const state of changed) {
        affected.add(state.memoryId);
        this.appendTransition(state.memoryId, before.get(state.memoryId), state.status, state.envelope.validity.checkedAt, "signal");
      }
    }
    const statuses: Record<string, MemoryStatus> = {};
    for (const memoryId of [...affected].sort()) statuses[memoryId] = this.states.stateOf(memoryId)!.status;
    return { roots: [...roots].sort(), affected: [...affected].sort(), statuses };
  }

  async validate(memoryIds: readonly string[], suppliedResults?: Readonly<Record<string, ValidationResult>>): Promise<ValidationReport> {
    const items: ValidationReportItem[] = [];
    const eventIds: string[] = [];
    for (const memoryId of memoryIds) {
      const state = this.states.stateOf(memoryId);
      if (!state) throw new Error(`Unknown memory: ${memoryId}`);
      const source = state.envelope.provenance?.[0];
      const result = suppliedResults?.[memoryId] ?? await this.runValidator(source, memoryId);
      const previousStatus = state.status;
      const nextStatus = statusForResult(result.result);
      const before = new Map(this.states.states().map((entry) => [entry.memoryId, entry.status]));
      const changed = this.states.markStatus(memoryId, nextStatus);
      for (const affected of changed) {
        const oldStatus = before.get(affected.memoryId);
        if (affected.memoryId === memoryId || oldStatus !== affected.status) {
          const id = this.appendTransition(affected.memoryId, oldStatus, affected.status, result.checkedAt, result.result, affected.memoryId === memoryId ? result.version : undefined);
          if (affected.memoryId === memoryId) eventIds.push(id);
        }
      }
      items.push({ memoryId, result: result.result, previousStatus, status: nextStatus, ...(result.version ? { version: result.version } : {}) });
    }
    return { items, eventIds };
  }

  check(memoryIds: readonly string[]): UsabilityReport {
    return { items: this.states.check(memoryIds) };
  }

  history(memoryId: string) {
    return this.journal.history(memoryId);
  }

  frontier(memoryIds: readonly string[]): readonly FrontierItem[] {
    const grouped = new Map<string, FrontierItem>();
    for (const memoryId of memoryIds) {
      const state = this.states.stateOf(memoryId);
      if (!state || state.status === "FRESH") continue;
      for (const source of state.envelope.provenance ?? []) {
        const key = `${source.sourceUri}|${source.version?.scheme ?? ""}|${source.version?.token ?? ""}`;
        const previous = grouped.get(key);
        grouped.set(key, previous ? { ...previous, memoryIds: [...new Set([...previous.memoryIds, memoryId])].sort() } : { ...source, memoryIds: [memoryId] });
      }
    }
    return [...grouped.values()].sort((left, right) => left.sourceUri.localeCompare(right.sourceUri));
  }

  private async runValidator(source: SourceReference | undefined, memoryId: string): Promise<ValidationResult> {
    if (!source?.validator) return { memoryId, result: "UNKNOWN", checkedAt: new Date().toISOString() };
    const validator = this.validators.get(source.validator.id);
    if (!validator) return { memoryId, result: "UNKNOWN", checkedAt: new Date().toISOString(), ...(source.version ? { version: source.version } : {}) };
    return validator.validate(source);
  }

  private appendTransition(memoryId: string, previousStatus: MemoryStatus | undefined, nextStatus: MemoryStatus, occurredAt: string, reason: string, version?: VersionReference): string {
    if (previousStatus === nextStatus && reason !== "UNCHANGED") return `${reason}:${memoryId}:unchanged`;
    const id = eventId(nextStatus === "INVALID" ? "invalidated" : nextStatus === "STALE" ? "staled" : "revalidated", memoryId, this.sequence++);
    if (nextStatus === "INVALID") this.journal.append({ specVersion: SPEC_VERSION, eventId: id, type: "MemoryInvalidated", occurredAt, memoryId, payload: { reason } });
    else if (nextStatus === "STALE") this.journal.append({ specVersion: SPEC_VERSION, eventId: id, type: "MemoryStaled", occurredAt, memoryId, payload: { reason } });
    else this.journal.append({ specVersion: SPEC_VERSION, eventId: id, type: "MemoryRevalidated", occurredAt, memoryId, payload: { result: reason === "UNCHANGED" ? "UNCHANGED" : "UNKNOWN", status: nextStatus, ...(reason === "UNCHANGED" ? { version: version ?? { scheme: "dependency", token: memoryId } } : {}) } });
    return id;
  }
}
