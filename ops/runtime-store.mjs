export const DEFAULT_DURABLE_WRITE_CONCURRENCY = 4;
const MAX_DURABLE_WRITE_CONCURRENCY = 64;
export const DEFAULT_MAX_PENDING_WRITES = 10_000;
const MAX_PENDING_WRITES = 1_000_000;
const MAX_EVENT_BATCH_SIZE = 64;
const DEFAULT_STARTUP_BATCH_SIZE = 1_000;
const MAX_STARTUP_BATCH_SIZE = 10_000;
const hydrateRecord = Symbol("hydrateRecord");
const hydrateEvent = Symbol("hydrateEvent");

function clone(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("PREMiSE runtime values must be JSON serializable");
  return JSON.parse(serialized);
}

function writeConcurrency(options = {}) {
  const configured = options.concurrency ?? options.maxConcurrentWrites ?? process.env.PREMISE_RUNTIME_WRITE_CONCURRENCY ?? DEFAULT_DURABLE_WRITE_CONCURRENCY;
  const value = typeof configured === "number"
    ? configured
    : typeof configured === "string" && /^\d+$/u.test(configured.trim())
      ? Number(configured.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DURABLE_WRITE_CONCURRENCY) {
    throw new TypeError(`Durable mirror write concurrency must be an integer from 1 to ${MAX_DURABLE_WRITE_CONCURRENCY}`);
  }
  return value;
}

function maxPendingWrites(options = {}) {
  const configured = options.maxPendingWrites ?? process.env.PREMISE_RUNTIME_MAX_PENDING_WRITES ?? DEFAULT_MAX_PENDING_WRITES;
  const value = typeof configured === "number"
    ? configured
    : typeof configured === "string" && /^\d+$/u.test(configured.trim())
      ? Number(configured.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PENDING_WRITES) {
    throw new TypeError(`Durable mirror max pending writes must be an integer from 1 to ${MAX_PENDING_WRITES}`);
  }
  return value;
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

const FRESHNESS_STATES = ["FRESH", "STALE", "INVALID", "UNKNOWN"];

function freshnessState(record) {
  const status = record?.envelope?.validity?.status;
  return FRESHNESS_STATES.includes(status) ? status : undefined;
}

export class DurableMirrorStore {
  constructor(persistent, snapshot, options = {}) {
    this.persistent = persistent;
    this.concurrency = writeConcurrency(options);
    this.maxPendingWrites = maxPendingWrites(options);
    this.records = new Map(snapshot.records.map((record) => [record.envelope.memoryId, clone(record)]));
    this.events = new Map(snapshot.events.map((event) => [event.idempotencyKey, clone(event)]));
    this.freshness = new Map(FRESHNESS_STATES.map((status) => [status, 0]));
    for (const record of this.records.values()) this.adjustFreshness(record, 1);
    this.ready = [];
    this.tasks = new Set();
    this.recordTails = new Map();
    this.pendingPuts = new Set();
    this.lastEventTask = undefined;
    this.eventBatch = undefined;
    this.restoreTask = undefined;
    this.activeWrites = 0;
    this.pendingWrites = 0;
    this.failure = undefined;
    this.closed = false;
    this.closePromise = undefined;
    this.revision = 0;
  }

  get freshnessCounts() {
    return Object.fromEntries(this.freshness);
  }

  get(memoryId) {
    const record = this.records.get(memoryId);
    return record === undefined ? undefined : clone(record);
  }

  list() {
    return [...this.records.values()].map(clone);
  }

  [hydrateRecord](record) {
    const copy = clone(record);
    const previous = this.records.get(copy.envelope.memoryId);
    if (previous !== undefined) this.adjustFreshness(previous, -1);
    this.records.set(copy.envelope.memoryId, copy);
    this.adjustFreshness(copy, 1);
  }

  [hydrateEvent](event) {
    const copy = clone(event);
    const existing = this.events.get(copy.idempotencyKey);
    if (existing !== undefined && (existing.eventId !== copy.eventId || existing.requestDigest !== copy.requestDigest)) {
      throw new Error(`Conflicting idempotency key during startup: ${copy.idempotencyKey}`);
    }
    this.events.set(copy.idempotencyKey, copy);
  }

  put(record) {
    this.ensureWritable();
    this.ensureCapacity();
    const copy = clone(record);
    const previous = this.records.get(copy.envelope.memoryId);
    if (previous !== undefined) this.adjustFreshness(previous, -1);
    this.records.set(copy.envelope.memoryId, copy);
    this.adjustFreshness(copy, 1);
    this.revision += 1;
    const dependencies = [];
    if (this.restoreTask !== undefined) dependencies.push(this.restoreTask);
    const recordTail = this.recordTails.get(copy.envelope.memoryId);
    if (recordTail !== undefined) dependencies.push(recordTail);
    const task = this.enqueue(() => this.persistent.put(clone(copy)), dependencies);
    this.recordTails.set(copy.envelope.memoryId, task);
    this.pendingPuts.add(task);
    task.done.then(() => {
      this.pendingPuts.delete(task);
      if (this.recordTails.get(copy.envelope.memoryId) === task) this.recordTails.delete(copy.envelope.memoryId);
    });
  }

  putAndAppend(record, event) {
    this.ensureWritable();
    this.ensureCapacity();
    const copy = clone(record);
    const eventCopy = clone(event);
    const existing = this.events.get(eventCopy.idempotencyKey);
    if (existing !== undefined && (existing.eventId !== eventCopy.eventId || existing.requestDigest !== eventCopy.requestDigest)) {
      throw new Error(`Conflicting idempotency key: ${eventCopy.idempotencyKey}`);
    }
    const previous = this.records.get(copy.envelope.memoryId);
    if (previous !== undefined) this.adjustFreshness(previous, -1);
    this.records.set(copy.envelope.memoryId, copy);
    this.adjustFreshness(copy, 1);
    this.events.set(eventCopy.idempotencyKey, eventCopy);
    this.revision += 1;
    // A combined record/event task closes any open event batch. Otherwise a
    // later appendEvent could join that batch while this task waits for it.
    this.eventBatch = undefined;
    const dependencies = [];
    if (this.restoreTask !== undefined) dependencies.push(this.restoreTask);
    if (this.lastEventTask !== undefined) dependencies.push(this.lastEventTask);
    const recordTail = this.recordTails.get(copy.envelope.memoryId);
    if (recordTail !== undefined) dependencies.push(recordTail);
    const task = this.enqueue(async () => {
      if (typeof this.persistent.putAndAppend === "function") {
        await this.persistent.putAndAppend(clone(copy), clone(eventCopy));
        return;
      }
      await this.persistent.put(clone(copy));
      await this.persistent.appendEvent(clone(eventCopy));
    }, dependencies);
    this.recordTails.set(copy.envelope.memoryId, task);
    this.lastEventTask = task;
    this.pendingPuts.add(task);
    task.done.then(() => {
      this.pendingPuts.delete(task);
      if (this.recordTails.get(copy.envelope.memoryId) === task) this.recordTails.delete(copy.envelope.memoryId);
    });
  }

  appendEvent(event) {
    this.ensureWritable();
    const copy = clone(event);
    const existing = this.events.get(copy.idempotencyKey);
    if (existing !== undefined) {
      if (existing.eventId !== copy.eventId || existing.requestDigest !== copy.requestDigest) throw new Error(`Conflicting idempotency key: ${copy.idempotencyKey}`);
      return;
    }
    this.ensureCapacity();
    this.events.set(copy.idempotencyKey, copy);
    let batch = this.eventBatch;
    if (batch === undefined) {
      batch = { events: [], dependencies: new Set(), task: undefined };
      const dependencies = [];
      if (this.lastEventTask !== undefined) dependencies.push(this.lastEventTask);
      if (this.restoreTask !== undefined) dependencies.push(this.restoreTask);
      batch.task = this.enqueue(() => this.flushEventBatch(batch), dependencies);
      this.eventBatch = batch;
      this.lastEventTask = batch.task;
    }
    batch.events.push(copy);
    for (const pendingPut of this.pendingPuts) batch.dependencies.add(pendingPut);
    if (this.restoreTask !== undefined) batch.dependencies.add(this.restoreTask);
    if (batch.events.length >= MAX_EVENT_BATCH_SIZE && this.eventBatch === batch) this.eventBatch = undefined;
  }

  hasEvent(idempotencyKey) {
    return this.events.has(idempotencyKey);
  }

  getEvent(idempotencyKey) {
    const event = this.events.get(idempotencyKey);
    return event === undefined ? undefined : clone(event);
  }

  countEvents() {
    return this.events.size;
  }

  listEvents() {
    return [...this.events.values()].map(clone);
  }

  snapshot(capturedAt) {
    return snapshotFromMaps(this.records, this.events, capturedAt);
  }

  restore(snapshot) {
    this.ensureWritable();
    this.ensureCapacity();
    const copy = clone(snapshot);
    this.records = new Map(copy.records.map((record) => [record.envelope.memoryId, record]));
    this.events = new Map(copy.events.map((event) => [event.idempotencyKey, event]));
    this.freshness = new Map(FRESHNESS_STATES.map((status) => [status, 0]));
    for (const record of this.records.values()) this.adjustFreshness(record, 1);
    this.revision += 1;
    // Close the current event batch before enqueueing a restore barrier. New
    // events must wait for restore rather than forming a dependency cycle.
    this.eventBatch = undefined;
    const task = this.enqueue(() => this.persistent.restore(clone(copy)), [...this.tasks]);
    this.restoreTask = task;
  }

  async flush() {
    const tasks = [...this.tasks];
    await Promise.all(tasks.map((task) => task.done));
    if (this.failure !== undefined) throw this.failure;
  }

  async close() {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      let failure;
      try {
        await this.flush();
      } catch (error) {
        failure = error;
      }
      try {
        await this.persistent.close?.();
      } catch (error) {
        this.failure ??= error;
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
    })();
    return this.closePromise;
  }

  ensureWritable() {
    if (this.failure !== undefined) throw this.failure;
    if (this.closed) throw new Error("Durable mirror store is closed");
  }

  ensureCapacity() {
    if (this.pendingWrites >= this.maxPendingWrites) {
      const error = new Error("Durable persistence queue is full; retry after the current writes drain");
      error.code = "PERSISTENCE_BACKPRESSURE";
      throw error;
    }
  }

  adjustFreshness(record, delta) {
    const status = freshnessState(record);
    if (status !== undefined) this.freshness.set(status, (this.freshness.get(status) ?? 0) + delta);
  }

  enqueue(action, dependencies = []) {
    this.ensureWritable();
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const task = {
      action,
      dependencies: new Set(dependencies.filter((dependency) => !dependency.settled)),
      dependents: new Set(),
      started: false,
      settled: false,
      done,
      resolveDone
    };
    this.pendingWrites += 1;
    this.tasks.add(task);
    for (const dependency of task.dependencies) dependency.dependents.add(task);
    if (task.dependencies.size === 0) this.ready.push(task);
    this.pump();
    return task;
  }

  async flushEventBatch(batch) {
    // Let other request continuations in this event-loop turn join the batch,
    // then wait for their record writes before publishing ordered events.
    await new Promise((resolve) => setImmediate(resolve));
    if (this.eventBatch === batch) this.eventBatch = undefined;
    await Promise.all([...batch.dependencies].filter((dependency) => !dependency.settled).map((dependency) => dependency.done));
    if (this.failure !== undefined) throw this.failure;
    const events = batch.events.map(clone);
    if (typeof this.persistent.appendEvents === "function") {
      await this.persistent.appendEvents(events);
      return;
    }
    for (const event of events) await this.persistent.appendEvent(event);
  }

  pump() {
    while (this.activeWrites < this.concurrency && this.ready.length > 0) {
      const task = this.ready.shift();
      if (task.settled) continue;
      if (this.failure !== undefined) {
        this.settle(task, this.failure);
        continue;
      }
      task.started = true;
      this.activeWrites += 1;
      Promise.resolve().then(task.action).then(
        () => this.settle(task),
        (error) => {
          const failure = error === undefined ? new Error("Durable persistence failed") : error;
          this.failure ??= failure;
          this.settle(task, failure);
          this.cancelQueued(this.failure);
        }
      );
    }
  }

  cancelQueued(error) {
    for (const task of [...this.tasks]) if (!task.started && !task.settled) this.settle(task, error);
  }

  settle(task, error) {
    if (task.settled) return;
    task.settled = true;
    task.error = error;
    if (task.started) this.activeWrites -= 1;
    this.pendingWrites -= 1;
    this.tasks.delete(task);
    for (const dependent of [...task.dependents]) {
      task.dependents.delete(dependent);
      dependent.dependencies.delete(task);
      if (dependent.dependencies.size === 0 && !dependent.settled) this.ready.push(dependent);
    }
    for (const dependency of task.dependencies) dependency.dependents.delete(task);
    task.resolveDone();
    this.pump();
  }
}

export async function openDurableMirror(client, tablePrefix, tenantId, options = {}) {
  const { PostgresRuntimeStore } = await import("@premise/store-postgres");
  const persistent = new PostgresRuntimeStore(client, { tablePrefix, tenantId });
  const configuredBatchSize = options.startupBatchSize ?? process.env.PREMISE_RUNTIME_STARTUP_BATCH_SIZE ?? DEFAULT_STARTUP_BATCH_SIZE;
  const startupBatchSize = typeof configuredBatchSize === "number"
    ? configuredBatchSize
    : typeof configuredBatchSize === "string" && /^\d+$/u.test(configuredBatchSize.trim())
      ? Number(configuredBatchSize.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(startupBatchSize) || startupBatchSize < 1 || startupBatchSize > MAX_STARTUP_BATCH_SIZE) {
    await persistent.close().catch(() => undefined);
    throw new TypeError(`PREMISE_RUNTIME_STARTUP_BATCH_SIZE must be an integer from 1 to ${MAX_STARTUP_BATCH_SIZE}`);
  }
  if (typeof persistent.loadIncrementally !== "function") {
    await persistent.close().catch(() => undefined);
    throw new Error("PostgresRuntimeStore incremental startup loader is required");
  }
  const emptySnapshot = {
    format: "premise-runtime-snapshot",
    version: 1,
    capturedAt: new Date().toISOString(),
    records: [],
    events: []
  };
  const mirror = new DurableMirrorStore(persistent, emptySnapshot, options);
  try {
    // This bounds PostgreSQL hydration. The production server uses the
    // persisted PostgreSQL lexical index directly after this returns; it
    // does not rebuild a full in-memory query index from mirror.list().
    await persistent.loadIncrementally({
      batchSize: startupBatchSize,
      onRecord: (record) => mirror[hydrateRecord](record),
      onEvent: (event) => mirror[hydrateEvent](event)
    });
    return { mirror, persistent };
  } catch (error) {
    await persistent.close().catch(() => undefined);
    throw error;
  }
}
