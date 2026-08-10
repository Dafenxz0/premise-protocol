import { createHash } from "node:crypto";
import {
  parseMemoryEnvelopeV2,
  parseV2Event,
  SPEC_VERSION_V2,
  type EvidenceReference,
  type MemoryEnvelopeV2,
  type V2Event,
  type V2MemoryStatus,
  type VersionReference
} from "@premise/protocol-types";

export interface RuntimeRecord<T> {
  readonly envelope: MemoryEnvelopeV2;
  readonly content: T;
}

export interface RuntimeSnapshot<T> {
  readonly format: "premise-runtime-snapshot";
  readonly version: 1;
  readonly capturedAt: string;
  readonly records: readonly RuntimeRecord<T>[];
  readonly events: readonly V2Event[];
}

export interface RuntimeStore<T> {
  /** Monotonic record-state revision when the store can expose one. */
  readonly revision?: number;
  get(memoryId: string): RuntimeRecord<T> | undefined;
  list(): readonly RuntimeRecord<T>[];
  put(record: RuntimeRecord<T>): void;
  appendEvent(event: V2Event): void;
  hasEvent(idempotencyKey: string): boolean;
  listEvents(): readonly V2Event[];
  snapshot(capturedAt: string): RuntimeSnapshot<T>;
  restore(snapshot: RuntimeSnapshot<T>): void;
}

export interface RuntimePrincipal {
  readonly tenantId: string;
  readonly subjectId?: string;
  readonly roles?: readonly string[];
}

export interface RuntimeOptions<T> {
  readonly store?: RuntimeStore<T>;
  readonly tenantId?: string;
  readonly principal?: RuntimePrincipal;
  readonly now?: () => string;
}

export interface RuntimeCheckItem {
  readonly memoryId: string;
  readonly status: V2MemoryStatus;
  readonly decision: "USABLE" | "REVALIDATE" | "REJECT";
  readonly reason?: string;
}

export interface RuntimeRetrieval<T> extends RuntimeRecord<T> {
  readonly status: V2MemoryStatus;
  readonly decision: "USABLE" | "REVALIDATE";
}

export interface RuntimeValidationReport {
  readonly memoryId: string;
  readonly result: "UNCHANGED" | "CHANGED" | "MISSING" | "UNKNOWN";
  readonly status: V2MemoryStatus;
  readonly checkedAt: string;
  readonly sourceUri?: string;
  readonly version?: VersionReference;
  readonly evidenceId?: string;
  readonly reason?: string;
}

export type RuntimeValidator<T> = (evidence: EvidenceReference, record: RuntimeRecord<T>) => Promise<RuntimeValidationReport>;

function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("PREMiSE runtime values must be JSON serializable");
  return JSON.parse(serialized) as T;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function usability(status: V2MemoryStatus): RuntimeCheckItem["decision"] {
  if (status === "FRESH") return "USABLE";
  if (status === "INVALID") return "REJECT";
  return "REVALIDATE";
}

function digestFor(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export class InMemoryRuntimeStore<T> implements RuntimeStore<T> {
  private readonly records = new Map<string, RuntimeRecord<T>>();
  private readonly events = new Map<string, V2Event>();
  private _revision = 0;

  get revision(): number {
    return this._revision;
  }

  get(memoryId: string): RuntimeRecord<T> | undefined {
    const record = this.records.get(memoryId);
    return record === undefined ? undefined : cloneJson(record);
  }

  list(): readonly RuntimeRecord<T>[] {
    return [...this.records.values()].map((record) => cloneJson(record));
  }

  put(record: RuntimeRecord<T>): void {
    const envelope = parseMemoryEnvelopeV2(record.envelope);
    this.records.set(envelope.memoryId, cloneJson({ envelope, content: record.content }));
    this._revision += 1;
  }

  appendEvent(event: V2Event): void {
    const existing = this.events.get(event.idempotencyKey);
    if (existing !== undefined) {
      if (existing.eventId !== event.eventId || existing.requestDigest !== event.requestDigest) throw new Error(`Conflicting idempotency key: ${event.idempotencyKey}`);
      return;
    }
    this.events.set(event.idempotencyKey, cloneJson(parseV2Event(event)));
  }

  hasEvent(idempotencyKey: string): boolean {
    return this.events.has(idempotencyKey);
  }

  listEvents(): readonly V2Event[] {
    return [...this.events.values()].map((event) => cloneJson(event));
  }

  snapshot(capturedAt: string): RuntimeSnapshot<T> {
    return { format: "premise-runtime-snapshot", version: 1, capturedAt, records: this.list(), events: this.listEvents() };
  }

  restore(snapshot: RuntimeSnapshot<T>): void {
    if (snapshot.format !== "premise-runtime-snapshot" || snapshot.version !== 1) throw new Error("Unsupported PREMiSE runtime snapshot");
    this.records.clear();
    this.events.clear();
    for (const record of snapshot.records) this.put(record);
    for (const event of snapshot.events) this.appendEvent(event);
  }
}

function readStoreRevision<T>(store: RuntimeStore<T>): number | undefined {
  return Number.isSafeInteger(store.revision) && (store.revision ?? -1) >= 0 ? store.revision : undefined;
}

export class PremiseRuntime<T = unknown> {
  readonly store: RuntimeStore<T>;
  readonly tenantId: string;
  readonly principal: RuntimePrincipal;
  private readonly now: () => string;
  private sequence = 0;
  /**
   * Reverse indexes let source invalidation avoid scanning every record and
   * rebuilding the dependency graph on every notification. They are scoped to
   * this runtime's tenant; records for other tenants are deliberately ignored.
   */
  private readonly sourceMemoryIds = new Map<string, Set<string>>();
  private readonly dependentsByDependency = new Map<string, Set<string>>();
  private readonly recordOrder = new Map<string, number>();
  private nextRecordOrder = 0;
  private indexedStoreRevision: number | undefined;

  constructor(options: RuntimeOptions<T> = {}) {
    this.store = options.store ?? new InMemoryRuntimeStore<T>();
    this.tenantId = options.tenantId ?? options.principal?.tenantId ?? "default";
    this.principal = options.principal ?? { tenantId: this.tenantId, subjectId: "runtime" };
    this.now = options.now ?? (() => new Date().toISOString());
    this.rebuildIndexes();
  }

  register(record: RuntimeRecord<T>, eventId?: string): void {
    const envelope = parseMemoryEnvelopeV2(record.envelope);
    this.assertTenant(envelope.tenantId);
    if (this.store.get(envelope.memoryId) !== undefined) throw new Error(`Memory already registered: ${envelope.memoryId}`);
    this.store.put({ envelope, content: cloneJson(record.content) });
    this.indexRecord({ envelope, content: record.content });
    this.emit("MemoryRegistered", envelope.memoryId, { envelope }, eventId ?? `register:${envelope.memoryId}`);
    this.syncStoreRevision();
  }

  derive(record: RuntimeRecord<T>, eventId?: string): void {
    const envelope = parseMemoryEnvelopeV2(record.envelope);
    this.assertTenant(envelope.tenantId);
    if (this.store.get(envelope.memoryId) !== undefined) throw new Error(`Memory already registered: ${envelope.memoryId}`);
    if (envelope.dependsOn.length === 0) throw new Error("Derived memory must have at least one dependency");
    for (const dependencyId of envelope.dependsOn) {
      const dependency = this.store.get(dependencyId);
      if (dependency === undefined || dependency.envelope.tenantId !== this.tenantId) throw new Error(`Missing required dependency: ${dependencyId}`);
    }
    this.store.put({ envelope, content: cloneJson(record.content) });
    this.indexRecord({ envelope, content: record.content });
    this.emit("MemoryDerived", envelope.memoryId, { dependsOn: envelope.dependsOn }, eventId ?? `derive:${envelope.memoryId}`);
    this.syncStoreRevision();
  }

  replace(memoryId: string, content: T, envelope: MemoryEnvelopeV2, eventId?: string): void {
    const current = this.require(memoryId);
    const next = parseMemoryEnvelopeV2(envelope);
    if (next.memoryId !== memoryId) throw new Error("Replacement must keep the memory ID");
    this.assertTenant(next.tenantId);
    this.store.put({ envelope: next, content: cloneJson(content) });
    this.deindexRecord(current);
    this.indexRecord({ envelope: next, content });
    this.emit("MemoryReplaced", memoryId, { previousDigest: current.envelope.contentDigest, nextDigest: next.contentDigest }, eventId ?? `replace:${memoryId}:${next.contentDigest ?? "none"}`);
    this.syncStoreRevision();
  }

  get(memoryId: string, principal = this.principal): RuntimeRecord<T> | undefined {
    const record = this.store.get(memoryId);
    return record !== undefined && record.envelope.tenantId === principal.tenantId ? record : undefined;
  }

  list(principal = this.principal): readonly RuntimeRecord<T>[] {
    return this.store.list().filter((record) => record.envelope.tenantId === principal.tenantId);
  }

  check(memoryIds: readonly string[], principal = this.principal): readonly RuntimeCheckItem[] {
    return memoryIds.map((memoryId): RuntimeCheckItem => {
      const record = this.get(memoryId, principal);
      if (record === undefined) return { memoryId, status: "INVALID", decision: "REJECT", reason: "missing or inaccessible memory" };
      return { memoryId, status: record.envelope.validity.status, decision: usability(record.envelope.validity.status) };
    });
  }

  retrieve(memoryIds: readonly string[], principal = this.principal): readonly RuntimeRetrieval<T>[] {
    const state = new Map(this.check(memoryIds, principal).map((item) => [item.memoryId, item]));
    const result: RuntimeRetrieval<T>[] = [];
    for (const memoryId of unique(memoryIds)) {
      const record = this.get(memoryId, principal);
      const item = state.get(memoryId);
      if (record === undefined || item === undefined || item.decision === "REJECT") continue;
      result.push({ ...record, status: item.status, decision: item.decision });
    }
    return result;
  }

  async revalidate(memoryId: string, validator: RuntimeValidator<T>, eventId?: string): Promise<RuntimeValidationReport> {
    const record = this.require(memoryId);
    if (record.envelope.evidence.length === 0) return this.applyValidation(record, { memoryId, result: "UNKNOWN", status: "UNKNOWN", checkedAt: this.now(), reason: "memory has no evidence" }, eventId);
    const reports: RuntimeValidationReport[] = [];
    for (const evidence of record.envelope.evidence) reports.push(await validator(evidence, record));
    const priority: readonly RuntimeValidationReport["result"][] = ["MISSING", "CHANGED", "UNKNOWN", "UNCHANGED"];
    const selected = priority.map((result) => reports.find((report) => report.result === result)).find((report): report is RuntimeValidationReport => report !== undefined) ?? reports[0]!;
    return this.applyValidation(record, selected, eventId);
  }

  signalSourceChanged(sourceUri: string, version: VersionReference, eventId?: string): readonly string[] {
    if (sourceUri.length === 0) throw new TypeError("sourceUri must be non-empty");
    this.refreshIndexesIfStoreChanged();
    const sourceEvent = this.emit("SourceChanged", undefined, { sourceUri, version }, eventId ?? `source:${sourceUri}:${version.scheme}:${version.token}`);
    const direct = this.orderedIds(this.sourceMemoryIds.get(sourceUri) ?? []);
    const affected = this.dependentClosure(direct);
    for (const memoryId of affected) {
      const record = this.store.get(memoryId);
      if (record === undefined || record.envelope.tenantId !== this.tenantId || record.envelope.validity.status === "INVALID" || record.envelope.validity.status === "STALE") continue;
      this.store.put({ envelope: this.withStatus(record.envelope, "STALE"), content: record.content });
      this.emit("MemoryStaled", memoryId, { sourceUri, version }, `${sourceEvent.eventId}:stale:${memoryId}`);
    }
    this.syncStoreRevision();
    return affected;
  }

  applyEvent(event: V2Event): boolean {
    if (this.store.hasEvent(event.idempotencyKey)) return false;
    const parsed = parseV2Event(event);
    this.assertTenant(parsed.tenantId);
    this.store.appendEvent(parsed);
    return true;
  }

  snapshot(): RuntimeSnapshot<T> {
    return this.store.snapshot(this.now());
  }

  restore(snapshot: RuntimeSnapshot<T>): void {
    for (const record of snapshot.records) this.assertTenant(record.envelope.tenantId);
    this.store.restore(snapshot);
    this.rebuildIndexes();
  }

  history(memoryId?: string): readonly V2Event[] {
    const events = this.store.listEvents();
    return memoryId === undefined ? events : events.filter((event) => event.memoryId === memoryId);
  }

  private applyValidation(record: RuntimeRecord<T>, report: RuntimeValidationReport, eventId?: string): RuntimeValidationReport {
    if (report.memoryId !== record.envelope.memoryId) throw new Error("Validation report memory ID does not match record");
    const status: V2MemoryStatus = report.result === "UNCHANGED" ? "FRESH" : report.result === "CHANGED" || report.result === "MISSING" ? "INVALID" : "UNKNOWN";
    this.store.put({ envelope: this.withStatus(record.envelope, status), content: record.content });
    this.emit("MemoryRevalidated", record.envelope.memoryId, { result: report.result, status, ...(report.version ? { version: report.version } : {}), ...(report.reason ? { reason: report.reason } : {}) }, eventId ?? `revalidate:${record.envelope.memoryId}:${report.checkedAt}`);
    this.syncStoreRevision();
    return { ...report, status };
  }

  private withStatus(envelope: MemoryEnvelopeV2, status: V2MemoryStatus): MemoryEnvelopeV2 {
    return parseMemoryEnvelopeV2({ ...envelope, validity: { ...envelope.validity, status, checkedAt: this.now() } });
  }

  private dependentClosure(seeds: readonly string[]): readonly string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    const queue = [...seeds];
    while (queue.length > 0) {
      const memoryId = queue.shift()!;
      if (seen.has(memoryId)) continue;
      seen.add(memoryId);
      result.push(memoryId);
      queue.push(...this.orderedIds(this.dependentsByDependency.get(memoryId) ?? []));
    }
    return result;
  }

  private rebuildIndexes(): void {
    this.sourceMemoryIds.clear();
    this.dependentsByDependency.clear();
    this.recordOrder.clear();
    this.nextRecordOrder = 0;
    for (const record of this.store.list()) this.indexRecord(record);
    this.indexedStoreRevision = readStoreRevision(this.store);
  }

  private refreshIndexesIfStoreChanged(): void {
    const currentRevision = readStoreRevision(this.store);
    // A custom RuntimeStore may be mutable without exposing a revision. Fall
    // back to a rebuild in that case so the optimization never changes the
    // observable behavior of the public store interface.
    if (currentRevision === undefined || currentRevision !== this.indexedStoreRevision) this.rebuildIndexes();
  }

  private syncStoreRevision(): void {
    this.indexedStoreRevision = readStoreRevision(this.store);
  }

  private indexRecord(record: RuntimeRecord<T>): void {
    if (record.envelope.tenantId !== this.tenantId) return;
    if (!this.recordOrder.has(record.envelope.memoryId)) this.recordOrder.set(record.envelope.memoryId, this.nextRecordOrder++);
    for (const evidence of record.envelope.evidence) {
      const records = this.sourceMemoryIds.get(evidence.sourceUri) ?? new Set<string>();
      records.add(record.envelope.memoryId);
      this.sourceMemoryIds.set(evidence.sourceUri, records);
    }
    for (const dependencyId of record.envelope.dependsOn) {
      const dependents = this.dependentsByDependency.get(dependencyId) ?? new Set<string>();
      dependents.add(record.envelope.memoryId);
      this.dependentsByDependency.set(dependencyId, dependents);
    }
  }

  private deindexRecord(record: RuntimeRecord<T>): void {
    if (record.envelope.tenantId !== this.tenantId) return;
    for (const evidence of record.envelope.evidence) {
      const records = this.sourceMemoryIds.get(evidence.sourceUri);
      if (records === undefined) continue;
      records.delete(record.envelope.memoryId);
      if (records.size === 0) this.sourceMemoryIds.delete(evidence.sourceUri);
    }
    for (const dependencyId of record.envelope.dependsOn) {
      const dependents = this.dependentsByDependency.get(dependencyId);
      if (dependents === undefined) continue;
      dependents.delete(record.envelope.memoryId);
      if (dependents.size === 0) this.dependentsByDependency.delete(dependencyId);
    }
  }

  private orderedIds(ids: Iterable<string>): string[] {
    return [...ids].sort((left, right) => (this.recordOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (this.recordOrder.get(right) ?? Number.MAX_SAFE_INTEGER));
  }

  private emit(type: V2Event["type"], memoryId: string | undefined, payload: Readonly<Record<string, unknown>>, idempotencyKey: string): V2Event {
    const existing = this.store.listEvents().find((event) => event.idempotencyKey === idempotencyKey);
    if (existing !== undefined) return existing;
    const eventId = `evt_${this.tenantId}_${++this.sequence}`;
    const event: V2Event = {
      specVersion: SPEC_VERSION_V2,
      tenantId: this.tenantId,
      eventId,
      operationId: eventId,
      idempotencyKey,
      requestDigest: digestFor(`${type}:${idempotencyKey}`),
      type,
      occurredAt: this.now(),
      ...(memoryId ? { memoryId } : {}),
      payload
    };
    this.store.appendEvent(event);
    return event;
  }

  private require(memoryId: string): RuntimeRecord<T> {
    const record = this.get(memoryId);
    if (record === undefined) throw new Error(`Memory not found or inaccessible: ${memoryId}`);
    return record;
  }

  private assertTenant(tenantId: string): void {
    if (tenantId !== this.tenantId) throw new Error(`Tenant boundary violation: ${tenantId}`);
  }
}
