import assert from "node:assert/strict";
import test from "node:test";
import { DurableMirrorStore } from "./runtime-store.mjs";

const emptySnapshot = { format: "premise-runtime-snapshot", version: 1, capturedAt: "2026-08-10T00:00:00.000Z", records: [], events: [] };

function record(memoryId, value) {
  return { envelope: { memoryId, validity: { status: value % 2 === 0 ? "FRESH" : "STALE" } }, content: { value } };
}

function event(id) {
  return { eventId: `event:${id}`, idempotencyKey: `request:${id}`, requestDigest: `sha256:${id}` };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

class PersistentFake {
  active = 0;
  maximumActive = 0;
  calls = [];
  gates = [];
  closed = false;

  put(value) { return this.start("put", value); }
  appendEvent(value) { return this.start("event", value); }
  restore(value) { return this.start("restore", value); }

  close() {
    this.closed = true;
  }

  start(kind, value) {
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    this.calls.push({ kind, value });
    return new Promise((resolve, reject) => {
      this.gates.push({ resolve: () => resolve(), reject: (error) => reject(error) });
    }).finally(() => {
      this.active -= 1;
    });
  }

  release() {
    const gate = this.gates.shift();
    assert.ok(gate, "expected a pending persistent operation");
    gate.resolve();
  }

  reject(error) {
    const gate = this.gates.shift();
    assert.ok(gate, "expected a pending persistent operation");
    gate.reject(error);
  }
}

class BatchPersistentFake extends PersistentFake {
  appendEvents(values) {
    return this.start("events", values);
  }
}

class AtomicPersistentFake extends PersistentFake {
  putAndAppend(recordValue, eventValue) {
    return this.start("put-events", { record: recordValue, event: eventValue });
  }
}

test("requires a strict bounded concurrency value", () => {
  assert.equal(new DurableMirrorStore(new PersistentFake(), emptySnapshot, { concurrency: "04" }).concurrency, 4);
  assert.equal(new DurableMirrorStore(new PersistentFake(), emptySnapshot, { maxPendingWrites: 12_345 }).maxPendingWrites, 12_345);
  assert.throws(() => new DurableMirrorStore(new PersistentFake(), emptySnapshot, { concurrency: "4foo" }), /integer/);
  assert.throws(() => new DurableMirrorStore(new PersistentFake(), emptySnapshot, { concurrency: 0 }), /integer/);
  assert.throws(() => new DurableMirrorStore(new PersistentFake(), emptySnapshot, { maxPendingWrites: 0 }), /pending writes/);
});

test("batches ordered events when the persistent store supports it", async () => {
  const persistent = new BatchPersistentFake();
  const store = new DurableMirrorStore(persistent, emptySnapshot, { concurrency: 2 });
  store.appendEvent(event("batch:1"));
  store.appendEvent(event("batch:2"));
  await tick();
  await tick();
  assert.equal(persistent.calls.length, 1);
  assert.equal(persistent.calls[0].kind, "events");
  assert.deepEqual(persistent.calls[0].value.map(({ eventId }) => eventId), ["event:batch:1", "event:batch:2"]);
  persistent.release();
  await store.flush();
});

test("atomically persists a record and its related event", async () => {
  const persistent = new AtomicPersistentFake();
  const store = new DurableMirrorStore(persistent, emptySnapshot, { concurrency: 2 });
  store.putAndAppend(record("memory:atomic", 1), event("atomic"));
  await tick();
  await tick();
  assert.deepEqual(persistent.calls.map(({ kind }) => kind), ["put-events"]);
  assert.equal(persistent.calls[0].value.record.envelope.memoryId, "memory:atomic");
  assert.equal(persistent.calls[0].value.event.eventId, "event:atomic");
  persistent.release();
  await store.flush();
});

test("limits active writes and keeps cloning", async () => {
  const persistent = new PersistentFake();
  const store = new DurableMirrorStore(persistent, emptySnapshot, { concurrency: 2 });
  const input = record("memory:0", 0);
  store.put(input);
  input.content.value = "mutated after enqueue";
  for (let index = 1; index < 5; index += 1) store.put(record(`memory:${index}`, index));

  await tick();
  assert.equal(persistent.active, 2);
  assert.equal(store.pendingWrites, 5);
  assert.equal(persistent.maximumActive, 2);
  while (persistent.gates.length > 0) {
    persistent.release();
    await tick();
  }
  await store.flush();
  assert.equal(store.pendingWrites, 0);
  assert.equal(persistent.maximumActive, 2);
  assert.equal(persistent.calls[0].value.content.value, 0);
});

test("maintains freshness counters without scanning records", async () => {
  const persistent = new PersistentFake();
  const store = new DurableMirrorStore(persistent, emptySnapshot, { concurrency: 2 });
  store.put(record("memory:fresh", 0));
  store.put(record("memory:stale", 1));
  await tick();
  assert.deepEqual(store.freshnessCounts, { FRESH: 1, STALE: 1, INVALID: 0, UNKNOWN: 0 });
  while (persistent.gates.length > 0) {
    persistent.release();
    await tick();
  }
  await store.flush();
  store.put(record("memory:fresh", 1));
  assert.deepEqual(store.freshnessCounts, { FRESH: 0, STALE: 2, INVALID: 0, UNKNOWN: 0 });
  await tick();
  persistent.release();
  await store.flush();
});

test("rejects new writes at the durable queue limit before mutating the mirror", async () => {
  const persistent = new PersistentFake();
  const store = new DurableMirrorStore(persistent, emptySnapshot, { concurrency: 1, maxPendingWrites: 1 });
  store.put(record("memory:admitted", 0));
  assert.throws(() => store.put(record("memory:rejected", 1)), (error) => error?.code === "PERSISTENCE_BACKPRESSURE");
  assert.equal(store.get("memory:rejected"), undefined);
  await tick();
  persistent.release();
  await store.flush();
});

test("flush waits for the writes present at its call, not later writes", async () => {
  const persistent = new PersistentFake();
  const store = new DurableMirrorStore(persistent, emptySnapshot, { concurrency: 1 });
  store.put(record("memory:first", 1));
  await tick();
  const flushed = store.flush();
  store.put(record("memory:later", 2));
  persistent.release();
  await flushed;
  assert.equal(store.pendingWrites, 1);
  assert.deepEqual(persistent.calls.map(({ value }) => value.envelope.memoryId), ["memory:first", "memory:later"]);
  persistent.release();
  await store.flush();
  assert.equal(store.pendingWrites, 0);
});

test("preserves event order and put-before-event recovery order", async () => {
  const persistent = new PersistentFake();
  const store = new DurableMirrorStore(persistent, emptySnapshot, { concurrency: 4 });
  store.put(record("memory:ordered", 1));
  store.appendEvent(event("1"));
  store.appendEvent(event("2"));
  store.appendEvent(event("3"));
  await tick();
  assert.deepEqual(persistent.calls.map(({ kind, value }) => `${kind}:${value.eventId ?? value.envelope.memoryId}`), ["put:memory:ordered"]);
  while (persistent.gates.length > 0) {
    persistent.release();
    await tick();
  }
  await store.flush();
  assert.deepEqual(persistent.calls.map(({ kind, value }) => `${kind}:${value.eventId ?? value.envelope.memoryId}`), [
    "put:memory:ordered", "event:event:1", "event:event:2", "event:event:3"
  ]);
});

test("restore is a durable barrier and later writes wait for it", async () => {
  const persistent = new PersistentFake();
  const store = new DurableMirrorStore(persistent, emptySnapshot, { concurrency: 2 });
  store.put(record("memory:before", 1));
  store.restore({ ...emptySnapshot, records: [record("memory:restored", 2)] });
  store.put(record("memory:after", 3));
  await tick();
  assert.deepEqual(persistent.calls.map(({ kind }) => kind), ["put"]);
  persistent.release();
  await tick();
  assert.deepEqual(persistent.calls.map(({ kind }) => kind), ["put", "restore"]);
  persistent.release();
  await tick();
  assert.deepEqual(persistent.calls.map(({ kind }) => kind), ["put", "restore", "put"]);
  persistent.release();
  await store.flush();
});

test("fails closed, drains in-flight work, and cancels queued work", async () => {
  const persistent = new PersistentFake();
  const store = new DurableMirrorStore(persistent, emptySnapshot, { concurrency: 2 });
  store.put(record("memory:one", 1));
  store.put(record("memory:two", 2));
  store.put(record("memory:three", 3));
  await tick();
  const failure = new Error("persistent unavailable");
  const flushed = store.flush();
  persistent.reject(failure);
  await tick();
  assert.equal(store.pendingWrites, 1);
  persistent.release();
  await assert.rejects(flushed, (error) => error === failure);
  assert.equal(store.failure, failure);
  assert.equal(store.pendingWrites, 0);
  assert.equal(persistent.calls.filter(({ value }) => value.envelope?.memoryId === "memory:three").length, 0);
  assert.throws(() => store.put(record("memory:after-failure", 4)), (error) => error === failure);
});

test("close waits for durability and prevents new writes", async () => {
  const persistent = new PersistentFake();
  const store = new DurableMirrorStore(persistent, emptySnapshot, { concurrency: 1 });
  store.put(record("memory:close", 1));
  await tick();
  const closing = store.close();
  await tick();
  assert.equal(persistent.closed, false);
  persistent.release();
  await closing;
  assert.equal(persistent.closed, true);
  assert.throws(() => store.put(record("memory:after-close", 2)), /closed/);
});

console.log("runtime-store tests passed");
