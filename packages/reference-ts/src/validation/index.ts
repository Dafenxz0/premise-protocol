import {
  SPEC_VERSION,
  isValidationResult,
  parseMemoryEnvelope,
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
  validate(source: SourceReference & { readonly memoryId?: string }): Promise<ValidationResult> | ValidationResult;
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
  readonly states: MemoryStateStore;
  readonly journal = new EventJournal();
  private readonly validators = new Map<string, Validator>();
  private sequence = 0;

  constructor(now?: () => string) {
    this.states = new MemoryStateStore(now);
  }

  registerValidator(validator: Validator): void {
    this.validators.set(validator.id, validator);
  }

  register(envelope: unknown): void {
    const parsed = parseMemoryEnvelope(envelope);
    const existing = this.states.stateOf(parsed.memoryId);
    if (existing && JSON.stringify(existing.envelope) === JSON.stringify(parsed)) return;
    const state = this.states.register(parsed);
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

  replace(envelope: unknown): void {
    const state = this.states.replace(envelope);
    this.journal.append({ specVersion: SPEC_VERSION, eventId: eventId("replaced", state.memoryId, this.sequence++), type: "MemoryReplaced", occurredAt: state.envelope.validity.checkedAt, memoryId: state.memoryId, payload: { replacementMemoryId: state.memoryId } });
  }

  signal(event: { readonly specVersion: typeof SPEC_VERSION; readonly eventId: string; readonly type: "SourceChanged"; readonly occurredAt: string; readonly payload: Readonly<Record<string, unknown>> }): PropagationReport {
    this.journal.append(event);
    const sourceUri = typeof event.payload.sourceUri === "string" ? event.payload.sourceUri : undefined;
    const roots = sourceUri === undefined ? [] : this.states.memoryIdsForSource(sourceUri);
    const affected = new Set<string>();
    for (const root of roots) {
      const changed = this.states.markStatusWithPrevious(root, "STALE");
      for (const { state, previousStatus } of changed) {
        affected.add(state.memoryId);
        this.appendTransition(state.memoryId, previousStatus, state.status, event.occurredAt, "signal");
      }
    }
    const statuses: Record<string, MemoryStatus> = {};
    for (const memoryId of [...affected].sort()) statuses[memoryId] = this.states.stateOf(memoryId)!.status;
    return { roots: [...roots].sort(), affected: [...affected].sort(), statuses };
  }

  async validate(memoryIds: readonly string[], suppliedResults?: Readonly<Record<string, ValidationResult>>): Promise<ValidationReport> {
    const items: ValidationReportItem[] = [];
    const eventIds: string[] = [];
    const prepared: { memoryId: string; previousStatus: MemoryStatus; result: ValidationResult }[] = [];
    for (const memoryId of memoryIds) {
      const state = this.states.stateOf(memoryId);
      if (!state) throw new Error(`Unknown memory: ${memoryId}`);
      const source = state.envelope.provenance?.[0];
      const result = suppliedResults?.[memoryId] ?? await this.runValidator(source, memoryId);
      if (result.memoryId !== memoryId || !isValidationResult(result)) throw new TypeError(`Invalid validation result for ${memoryId}`);
      prepared.push({ memoryId, previousStatus: state.status, result });
    }
    for (const { memoryId, previousStatus, result } of prepared) {
      const nextStatus = statusForResult(result.result);
      const changed = this.states.markStatusWithPrevious(memoryId, nextStatus);
      for (const { state, previousStatus: affectedPreviousStatus } of changed) {
        if (state.memoryId === memoryId || affectedPreviousStatus !== state.status) {
          const id = this.appendTransition(state.memoryId, affectedPreviousStatus, state.status, result.checkedAt, result.result, state.memoryId === memoryId ? result.version : undefined);
          if (state.memoryId === memoryId && id !== undefined) eventIds.push(id);
        }
      }
      items.push({ memoryId, result: result.result, previousStatus, status: this.states.stateOf(memoryId)?.status ?? nextStatus, ...(result.version ? { version: result.version } : {}) });
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
    const grouped = new Map<string, { source: SourceReference; memoryIds: Set<string> }>();
    for (const memoryId of memoryIds) {
      const state = this.states.stateOf(memoryId);
      if (!state || state.status === "FRESH") continue;
      for (const source of state.envelope.provenance ?? []) {
        const key = `${source.sourceUri}|${source.version?.scheme ?? ""}|${source.version?.token ?? ""}`;
        const previous = grouped.get(key);
        if (previous) previous.memoryIds.add(memoryId);
        else grouped.set(key, { source, memoryIds: new Set([memoryId]) });
      }
    }
    return [...grouped.values()]
      .map(({ source, memoryIds: ids }) => ({ ...source, memoryIds: [...ids].sort() }))
      .sort((left, right) => left.sourceUri.localeCompare(right.sourceUri));
  }

  private async runValidator(source: SourceReference | undefined, memoryId: string): Promise<ValidationResult> {
    if (!source?.validator) return { memoryId, result: "UNKNOWN", status: "UNKNOWN", checkedAt: new Date().toISOString() };
    const validator = this.validators.get(source.validator.id);
    if (!validator) return { memoryId, result: "UNKNOWN", status: "UNKNOWN", checkedAt: new Date().toISOString() };
    return validator.validate({ ...source, memoryId });
  }

  private appendTransition(memoryId: string, previousStatus: MemoryStatus | undefined, nextStatus: MemoryStatus, occurredAt: string, reason: string, version?: VersionReference): string | undefined {
    if (previousStatus === nextStatus && reason !== "UNCHANGED") return undefined;
    const id = eventId(nextStatus === "INVALID" ? "invalidated" : nextStatus === "STALE" ? "staled" : "revalidated", memoryId, this.sequence++);
    if (nextStatus === "INVALID") this.journal.append({ specVersion: SPEC_VERSION, eventId: id, type: "MemoryInvalidated", occurredAt, memoryId, payload: { reason } });
    else if (nextStatus === "STALE") this.journal.append({ specVersion: SPEC_VERSION, eventId: id, type: "MemoryStaled", occurredAt, memoryId, payload: { reason } });
    else this.journal.append({ specVersion: SPEC_VERSION, eventId: id, type: "MemoryRevalidated", occurredAt, memoryId, payload: { result: reason === "UNCHANGED" ? "UNCHANGED" : "UNKNOWN", status: nextStatus, ...(reason === "UNCHANGED" ? { version: version ?? { scheme: "dependency", token: memoryId } } : {}) } });
    return id;
  }
}
