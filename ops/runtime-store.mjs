export const DEFAULT_DURABLE_WRITE_CONCURRENCY = 4;
const MAX_DURABLE_WRITE_CONCURRENCY = 64;

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
  constructor(persistent, snapshot, options = {}) {
    this.persistent = persistent;
    this.concurrency = writeConcurrency(options);
    this.records = new Map(snapshot.records.map((record) => [record.envelope.memoryId, clone(record)]));
    this.events = new Map(snapshot.events.map((event) => [event.idempotencyKey, clone(event)]));
    this.ready = [];
    this.tasks = new Set();
    this.recordTails = new Map();
    this.pendingPuts = new Set();
    this.lastEventTask = undefined;
    this.restoreTask = undefined;
    this.activeWrites = 0;
    this.pendingWrites = 0;
    this.failure = undefined;
    this.closed = false;
    this.closePromise = undefined;
    this.revision = 0;
  }

  get(memoryId) {
    const record = this.records.get(memoryId);
    return record === undefined ? undefined : clone(record);
  }

  list() {
    return [...this.records.values()].map(clone);
  }

  put(record) {
    this.ensureWritable();
    const copy = clone(record);
    this.records.set(copy.envelope.memoryId, copy);
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

  appendEvent(event) {
    this.ensureWritable();
    const copy = clone(event);
    const existing = this.events.get(copy.idempotencyKey);
    if (existing !== undefined) {
      if (existing.eventId !== copy.eventId || existing.requestDigest !== copy.requestDigest) throw new Error(`Conflicting idempotency key: ${copy.idempotencyKey}`);
      return;
    }
    this.events.set(copy.idempotencyKey, copy);
    const dependencies = [...this.pendingPuts];
    if (this.restoreTask !== undefined) dependencies.push(this.restoreTask);
    if (this.lastEventTask !== undefined) dependencies.push(this.lastEventTask);
    const task = this.enqueue(() => this.persistent.appendEvent(clone(copy)), dependencies);
    this.lastEventTask = task;
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
    this.ensureWritable();
    const copy = clone(snapshot);
    this.records = new Map(copy.records.map((record) => [record.envelope.memoryId, record]));
    this.events = new Map(copy.events.map((event) => [event.idempotencyKey, event]));
    this.revision += 1;
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
  const snapshot = await persistent.snapshot(new Date().toISOString());
  return { mirror: new DurableMirrorStore(persistent, snapshot, options), persistent };
}
