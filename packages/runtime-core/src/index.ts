import { createHash, randomUUID } from "node:crypto";
import {
  MemoryV2SignatureReplayStore,
  parseAndVerifyMemoryEnvelopeV2,
  parseMemoryEnvelopeV2,
  parseV2Event,
  SPEC_VERSION_V2,
  type EvidenceReference,
  type MemoryEnvelopeV2,
  type V2SignatureVerificationOptions,
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
  /** Persist a record and its causally related event atomically when supported. */
  putAndAppend?(record: RuntimeRecord<T>, event: V2Event): void;
  getEvent?(idempotencyKey: string): V2Event | undefined;
  appendEvent(event: V2Event): void;
  hasEvent(idempotencyKey: string): boolean;
  countEvents?(): number;
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
  /**
   * Optional trust configuration for inbound v2 envelopes. When supplied,
   * every register/derive/replace/restore input must carry a valid Ed25519
   * signature resolved by this key source.
   */
  readonly signatureVerification?: V2SignatureVerificationOptions;
  /** Reject unsigned inbound envelopes even when no key source is configured. */
  readonly requireSignedEnvelopes?: boolean;
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

export interface RuntimeActionRequest<T = unknown> {
  readonly expectedVersion: string;
  readonly action?: unknown;
  readonly apply?: (record: RuntimeRecord<T>) => Promise<unknown> | unknown;
}

export interface RuntimeActionResult<T = unknown> {
  readonly accepted: boolean;
  readonly memoryId: string;
  readonly expectedVersion: string;
  readonly reason?: "VERSION_MISMATCH" | "REJECT" | "REVALIDATE";
  readonly result?: T;
}

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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("PREMiSE request values must be JSON serializable");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new TypeError("PREMiSE request values must be JSON serializable");
}

function digestFor(value: unknown): `sha256:${string}` {
  return `sha256:v2:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
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

  putAndAppend(record: RuntimeRecord<T>, event: V2Event): void {
    this.put(record);
    this.appendEvent(event);
  }

  getEvent(idempotencyKey: string): V2Event | undefined {
    const event = this.events.get(idempotencyKey);
    return event === undefined ? undefined : cloneJson(event);
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

  countEvents(): number {
    return this.events.size;
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
  private readonly signatureVerification: V2SignatureVerificationOptions | undefined;
  private readonly requireSignedEnvelopes: boolean;
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
    this.signatureVerification = options.signatureVerification;
    this.requireSignedEnvelopes = options.requireSignedEnvelopes ?? options.signatureVerification !== undefined;
    if (this.requireSignedEnvelopes && this.signatureVerification === undefined) {
      throw new TypeError("requireSignedEnvelopes requires signatureVerification with an external key source");
    }
    this.rebuildIndexes();
  }

  register(record: RuntimeRecord<T>, eventId?: string): void {
    const candidate = parseMemoryEnvelopeV2(record.envelope);
    const idempotencyKey = eventId ?? `register:${candidate.memoryId}`;
    const replay = this.eventFor(idempotencyKey);
    const envelope = this.trustedEnvelope(record.envelope, replay !== undefined);
    this.assertTenant(envelope.tenantId);
    if (eventId === undefined && this.store.get(envelope.memoryId) !== undefined) throw new Error(`Memory already registered: ${envelope.memoryId}`);
    const stored = { envelope, content: cloneJson(record.content) };
    const event = this.emit("MemoryRegistered", envelope.memoryId, { envelope }, idempotencyKey, false, { envelope, content: stored.content });
    if (replay !== undefined) {
      if (this.store.get(envelope.memoryId) === undefined) throw new Error(`Idempotent event has no corresponding memory: ${idempotencyKey}`);
      return;
    }
    if (this.store.get(envelope.memoryId) !== undefined) throw new Error(`Memory already registered: ${envelope.memoryId}`);
    this.persistRecordAndEvent(stored, event);
    this.indexRecord(stored);
    this.syncStoreRevision();
  }

  derive(record: RuntimeRecord<T>, eventId?: string): void {
    const candidate = parseMemoryEnvelopeV2(record.envelope);
    const idempotencyKey = eventId ?? `derive:${candidate.memoryId}`;
    const replay = this.eventFor(idempotencyKey);
    const envelope = this.trustedEnvelope(record.envelope, replay !== undefined);
    this.assertTenant(envelope.tenantId);
    if (eventId === undefined && this.store.get(envelope.memoryId) !== undefined) throw new Error(`Memory already registered: ${envelope.memoryId}`);
    if (envelope.dependsOn.length === 0) throw new Error("Derived memory must have at least one dependency");
    for (const dependencyId of envelope.dependsOn) {
      const dependency = this.store.get(dependencyId);
      if (dependency === undefined || dependency.envelope.tenantId !== this.tenantId) throw new Error(`Missing required dependency: ${dependencyId}`);
    }
    const stored = { envelope, content: cloneJson(record.content) };
    const event = this.emit("MemoryDerived", envelope.memoryId, { dependsOn: envelope.dependsOn }, idempotencyKey, false, { envelope, content: stored.content });
    if (replay !== undefined) {
      if (this.store.get(envelope.memoryId) === undefined) throw new Error(`Idempotent event has no corresponding memory: ${idempotencyKey}`);
      return;
    }
    if (this.store.get(envelope.memoryId) !== undefined) throw new Error(`Memory already registered: ${envelope.memoryId}`);
    this.persistRecordAndEvent(stored, event);
    this.indexRecord(stored);
    this.syncStoreRevision();
  }

  replace(memoryId: string, content: T, envelope: MemoryEnvelopeV2, eventId?: string): void {
    const current = this.require(memoryId);
    const candidate = parseMemoryEnvelopeV2(envelope);
    const idempotencyKey = eventId ?? `replace:${memoryId}:${candidate.contentDigest ?? "none"}`;
    const replay = this.eventFor(idempotencyKey);
    const next = this.trustedEnvelope(envelope, replay !== undefined);
    if (next.memoryId !== memoryId) throw new Error("Replacement must keep the memory ID");
    this.assertTenant(next.tenantId);
    const stored = { envelope: next, content: cloneJson(content) };
    const event = this.emit("MemoryReplaced", memoryId, { previousDigest: current.envelope.contentDigest, nextDigest: next.contentDigest }, idempotencyKey, false, { memoryId, envelope: next, content: stored.content });
    if (replay !== undefined) return;
    this.persistRecordAndEvent(stored, event);
    this.deindexRecord(current);
    this.indexRecord(stored);
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
    return this.checkMany(memoryIds, principal);
  }

  checkMany(memoryIds: readonly string[], principal = this.principal): readonly RuntimeCheckItem[] {
    const checked = new Map<string, RuntimeCheckItem>();
    for (const memoryId of memoryIds) {
      if (checked.has(memoryId)) continue;
      const record = this.get(memoryId, principal);
      checked.set(memoryId, record === undefined
        ? { memoryId, status: "INVALID", decision: "REJECT", reason: "missing or inaccessible memory" }
        : { memoryId, status: record.envelope.validity.status, decision: usability(record.envelope.validity.status) });
    }
    return memoryIds.map((memoryId) => checked.get(memoryId)!);
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

  async revalidateMany(memoryIds: readonly string[], validator: RuntimeValidator<T>, eventId?: string): Promise<readonly RuntimeValidationReport[]> {
    const ids: string[] = [];
    const records = new Map<string, RuntimeRecord<T>>();
    for (const memoryId of memoryIds) {
      if (records.has(memoryId)) continue;
      ids.push(memoryId);
      records.set(memoryId, this.require(memoryId));
    }
    const grouped = new Map<string, Promise<RuntimeValidationReport>>();
    const priority: readonly RuntimeValidationReport["result"][] = ["MISSING", "CHANGED", "UNKNOWN", "UNCHANGED"];

    const pending = ids.map((memoryId) => {
      const record = records.get(memoryId)!;
      const evidence = record.envelope.evidence;
      if (evidence.length === 0) {
        return Promise.resolve({
          memoryId,
          report: { memoryId, result: "UNKNOWN", status: "UNKNOWN", checkedAt: this.now(), reason: "memory has no evidence" } as RuntimeValidationReport
        });
      }
      const validations = evidence.map((item) => {
        const key = `${item.evidenceId}:${canonicalJson(item)}`;
        // Sharing is conservative: differing evidence payloads with the same key fall back to separate validation.
        let validation = grouped.get(key);
        if (validation === undefined) {
          validation = Promise.resolve().then(() => validator(item, record));
          grouped.set(key, validation);
        }
        return validation.then((report) => ({ ...report, memoryId }));
      });
      const reportsPromise = validations.length === 1 ? validations[0]!.then((report) => [report]) : Promise.all(validations);
      return reportsPromise.then((reports): { memoryId: string; report: RuntimeValidationReport } => ({
        memoryId,
        report: priority.map((result) => reports.find((report) => report.result === result)).find((report): report is RuntimeValidationReport => report !== undefined) ?? reports[0]!
      }));
    });
    const selected = new Map((await Promise.all(pending)).map(({ memoryId, report }) => [memoryId, report]));

    const applied = new Map(ids.map((memoryId) => {
      const report = selected.get(memoryId)!;
      return [memoryId, this.applyValidation(records.get(memoryId)!, report, eventId === undefined ? undefined : `${eventId}:${memoryId}`)] as const;
    }));
    return memoryIds.map((memoryId) => applied.get(memoryId)!);
  }

  /**
   * Guard an external side effect with the version observed by the caller.
   * The adapter performing the side effect still MUST provide its own atomic
   * CAS; this method prevents a caller from reusing a version that PREMiSE
   * has already replaced during revalidation.
   */
  async revalidateAndAct(memoryId: string, request: RuntimeActionRequest<T>): Promise<RuntimeActionResult<T>> {
    const record = this.require(memoryId);
    const versions = record.envelope.evidence.map((evidence) => evidence.version?.token).filter((token): token is string => typeof token === "string");
    if (versions.length === 0 || versions.some((version) => version !== request.expectedVersion)) {
      return { accepted: false, memoryId, expectedVersion: request.expectedVersion, reason: "VERSION_MISMATCH" };
    }
    const check = this.check([memoryId])[0]!;
    if (check.decision === "REJECT") return { accepted: false, memoryId, expectedVersion: request.expectedVersion, reason: "REJECT" };
    if (check.decision === "REVALIDATE") return { accepted: false, memoryId, expectedVersion: request.expectedVersion, reason: "REVALIDATE" };
    const result = request.apply === undefined ? undefined : await request.apply(record);
    return { accepted: true, memoryId, expectedVersion: request.expectedVersion, ...(result === undefined ? {} : { result: result as T }) };
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
      const stored = { envelope: this.withStatus(record.envelope, "STALE"), content: record.content };
      const staleEvent = this.emit("MemoryStaled", memoryId, { sourceUri, version }, `${sourceEvent.eventId}:stale:${memoryId}`, false);
      this.persistRecordAndEvent(stored, staleEvent);
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
    const records = snapshot.records.map((record) => {
      const envelope = this.trustedEnvelope(record.envelope);
      this.assertTenant(envelope.tenantId);
      return { ...record, envelope };
    });
    this.store.restore({ ...snapshot, records });
    this.rebuildIndexes();
  }

  history(memoryId?: string): readonly V2Event[] {
    const events = this.store.listEvents();
    return memoryId === undefined ? events : events.filter((event) => event.memoryId === memoryId);
  }

  eventCount(): number {
    return typeof this.store.countEvents === "function" ? this.store.countEvents() : this.store.listEvents().length;
  }

  private applyValidation(record: RuntimeRecord<T>, report: RuntimeValidationReport, eventId?: string): RuntimeValidationReport {
    if (report.memoryId !== record.envelope.memoryId) throw new Error("Validation report memory ID does not match record");
    const status: V2MemoryStatus = report.result === "UNCHANGED" ? "FRESH" : report.result === "CHANGED" || report.result === "MISSING" ? "INVALID" : "UNKNOWN";
    const stored = { envelope: this.withValidation(record.envelope, report, status), content: record.content };
    const event = this.emit("MemoryRevalidated", record.envelope.memoryId, { result: report.result, status, ...(report.version ? { version: report.version } : {}), ...(report.reason ? { reason: report.reason } : {}) }, eventId ?? `revalidate:${record.envelope.memoryId}:${report.checkedAt}`, false);
    this.persistRecordAndEvent(stored, event);
    this.syncStoreRevision();
    return { ...report, status };
  }

  private withStatus(envelope: MemoryEnvelopeV2, status: V2MemoryStatus): MemoryEnvelopeV2 {
    return parseMemoryEnvelopeV2({ ...envelope, validity: { ...envelope.validity, status, checkedAt: this.now() } });
  }

  private withValidation(envelope: MemoryEnvelopeV2, report: RuntimeValidationReport, status: V2MemoryStatus): MemoryEnvelopeV2 {
    if (report.result !== "UNCHANGED" || report.version === undefined) return this.withStatus(envelope, status);
    const evidence = envelope.evidence.map((item) => {
      const matches = report.evidenceId === undefined || item.evidenceId === report.evidenceId;
      const sameSource = report.sourceUri === undefined || item.sourceUri === report.sourceUri;
      return matches && sameSource ? { ...item, version: report.version, observedAt: report.checkedAt } : item;
    });
    return parseMemoryEnvelopeV2({ ...envelope, evidence, validity: { ...envelope.validity, status, checkedAt: this.now() } });
  }

  private dependentClosure(seeds: readonly string[]): readonly string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const seed of seeds) {
      if (seen.has(seed)) continue;
      seen.add(seed);
      queue.push(seed);
    }
    let cursor = 0;
    while (cursor < queue.length) {
      const memoryId = queue[cursor++]!;
      result.push(memoryId);
      for (const dependentId of this.orderedIds(this.dependentsByDependency.get(memoryId) ?? [])) {
        if (seen.has(dependentId)) continue;
        seen.add(dependentId);
        queue.push(dependentId);
      }
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

  private persistRecordAndEvent(record: RuntimeRecord<T>, event: V2Event): void {
    if (typeof this.store.putAndAppend === "function") this.store.putAndAppend(record, event);
    else {
      this.store.put(record);
      this.store.appendEvent(event);
    }
  }

  private eventFor(idempotencyKey: string): V2Event | undefined {
    return typeof this.store.getEvent === "function"
      ? this.store.getEvent(idempotencyKey)
      : this.store.listEvents().find((event) => event.idempotencyKey === idempotencyKey);
  }

  private emit(type: V2Event["type"], memoryId: string | undefined, payload: Readonly<Record<string, unknown>>, idempotencyKey: string, persist = true, requestPayload: unknown = payload): V2Event {
    const requestDigest = digestFor({ type, memoryId: memoryId ?? null, request: requestPayload });
    const existing = this.eventFor(idempotencyKey);
    if (existing !== undefined) {
      if (existing.type !== type || existing.memoryId !== memoryId || existing.requestDigest !== requestDigest) throw new Error(`Conflicting idempotency key: ${idempotencyKey}`);
      return existing;
    }
    const eventId = `evt_${this.tenantId}_${randomUUID()}`;
    const event: V2Event = {
      specVersion: SPEC_VERSION_V2,
      tenantId: this.tenantId,
      eventId,
      operationId: eventId,
      idempotencyKey,
      requestDigest,
      type,
      occurredAt: this.now(),
      ...(memoryId ? { memoryId } : {}),
      payload
    };
    if (persist) this.store.appendEvent(event);
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

  private trustedEnvelope(input: unknown, idempotentReplay = false): MemoryEnvelopeV2 {
    if (this.signatureVerification !== undefined) {
      const options = idempotentReplay
        ? { ...this.signatureVerification, replayStore: new MemoryV2SignatureReplayStore() }
        : this.signatureVerification;
      return parseAndVerifyMemoryEnvelopeV2(input, options);
    }
    const envelope = parseMemoryEnvelopeV2(input);
    if (this.requireSignedEnvelopes) throw new Error("Signed PREMiSE v2 envelopes are required");
    return envelope;
  }
}
