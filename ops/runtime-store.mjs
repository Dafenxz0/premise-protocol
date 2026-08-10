import { PostgresRuntimeStore } from "@premise/store-postgres";

function clone(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("PREMiSE runtime values must be JSON serializable");
  return JSON.parse(serialized);
}

function snapshotFromMaps(records, events, capturedAt) {
  return {
    format: "premise-runtime-snapshot",
    version: 1,
    capturedAt,
    records: [...records.values()].map(clone),
    events: [...events.values()].map(clone)
  };
}

export class DurableMirrorStore {
  constructor(persistent, snapshot) {
    this.persistent = persistent;
    this.records = new Map(snapshot.records.map((record) => [record.envelope.memoryId, clone(record)]));
    this.events = new Map(snapshot.events.map((event) => [event.idempotencyKey, clone(event)]));
    this.pending = Promise.resolve();
    this.pendingWrites = 0;
    this.failure = undefined;
  }

  get(memoryId) {
    const record = this.records.get(memoryId);
    return record === undefined ? undefined : clone(record);
  }

  list() {
    return [...this.records.values()].map(clone);
  }

  put(record) {
    const copy = clone(record);
    this.records.set(copy.envelope.memoryId, copy);
    this.enqueue(() => this.persistent.put(copy));
  }

  appendEvent(event) {
    const copy = clone(event);
    const existing = this.events.get(copy.idempotencyKey);
    if (existing !== undefined) {
      if (existing.eventId !== copy.eventId || existing.requestDigest !== copy.requestDigest) throw new Error(`Conflicting idempotency key: ${copy.idempotencyKey}`);
      return;
    }
    this.events.set(copy.idempotencyKey, copy);
    this.enqueue(() => this.persistent.appendEvent(copy));
  }

  hasEvent(idempotencyKey) {
    return this.events.has(idempotencyKey);
  }

  listEvents() {
    return [...this.events.values()].map(clone);
  }

  snapshot(capturedAt) {
    return snapshotFromMaps(this.records, this.events, capturedAt);
  }

  restore(snapshot) {
    const copy = clone(snapshot);
    this.records = new Map(copy.records.map((record) => [record.envelope.memoryId, record]));
    this.events = new Map(copy.events.map((event) => [event.idempotencyKey, event]));
    this.enqueue(() => this.persistent.restore(copy));
  }

  async flush() {
    await this.pending;
    if (this.failure !== undefined) throw this.failure;
  }

  enqueue(action) {
    this.pendingWrites += 1;
    const run = async () => {
      try {
        await action();
      } catch (error) {
        this.failure = error;
        throw error;
      } finally {
        this.pendingWrites -= 1;
      }
    };
    const next = this.pending.then(run, run);
    this.pending = next.catch(() => undefined);
  }
}

export async function openDurableMirror(client, tablePrefix, tenantId) {
  const persistent = new PostgresRuntimeStore(client, { tablePrefix, tenantId });
  const snapshot = await persistent.snapshot(new Date().toISOString());
  return { mirror: new DurableMirrorStore(persistent, snapshot), persistent };
}
