import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRuntimeStore, PremiseRuntime, RuntimeInstrumentationRecorder } from "../dist/index.js";

const at = "2026-08-14T00:00:00Z";
const streamEvent = (sequence, kind, token, overrides = {}) => ({
  specVersion: "premise/2",
  tenantId: "tenant:stream",
  eventId: `stream-event:${sequence}:${token}`,
  operationId: `stream-op:${sequence}:${token}`,
  idempotencyKey: `stream-idem:${sequence}:${token}`,
  requestDigest: `sha256:${token.padEnd(64, "a").slice(0, 64)}`,
  type: "SourceChanged",
  occurredAt: at,
  payload: { sourceUri: "source://repo", version: { scheme: "git", token } },
  streamId: "stream:repo",
  sequence,
  kind,
  cursor: `cursor:${sequence}`,
  ...overrides
});

test("runtime applies ordered stream events and exact duplicates only", () => {
  const instrumentation = new RuntimeInstrumentationRecorder();
  const runtime = new PremiseRuntime({ store: new InMemoryRuntimeStore(), tenantId: "tenant:stream", now: () => at, instrumentation });
  const snapshot = streamEvent(0, "SNAPSHOT", "a1");
  assert.deepEqual(runtime.applyStreamEvent(snapshot), { status: "APPLIED", streamId: "stream:repo", sequence: 0 });
  assert.deepEqual(runtime.applyStreamEvent(streamEvent(1, "DELTA", "a2")), { status: "APPLIED", streamId: "stream:repo", sequence: 1 });
  assert.deepEqual(runtime.applyStreamEvent(streamEvent(1, "DELTA", "a2")), { status: "DUPLICATE", streamId: "stream:repo", sequence: 1 });
  assert.equal(runtime.eventCount(), 2);
});

test("runtime restores continuity from an exact persisted event without trusting a conflicting replay", () => {
  const store = new InMemoryRuntimeStore();
  const first = new PremiseRuntime({ store, tenantId: "tenant:stream", now: () => at });
  const snapshot = streamEvent(0, "SNAPSHOT", "persisted");
  assert.deepEqual(first.applyStreamEvent(snapshot), { status: "APPLIED", streamId: "stream:repo", sequence: 0 });
  const restarted = new PremiseRuntime({ store, tenantId: "tenant:stream", now: () => at });
  assert.deepEqual(restarted.applyStreamEvent(snapshot), { status: "DUPLICATE", streamId: "stream:repo", sequence: 0 });
  assert.deepEqual(restarted.applyStreamEvent(streamEvent(1, "DELTA", "next")), { status: "APPLIED", streamId: "stream:repo", sequence: 1 });
  assert.equal(restarted.applyStreamEvent({ ...snapshot, payload: { sourceUri: "source://other", version: { scheme: "git", token: "persisted" } } }).reason, "CONFLICT");
});

test("runtime fails closed on delta-before-snapshot, gaps, reorder, and same-sequence conflicts", () => {
  const instrumentation = new RuntimeInstrumentationRecorder();
  const runtime = new PremiseRuntime({ tenantId: "tenant:stream", now: () => at, instrumentation });
  assert.equal(runtime.applyStreamEvent(streamEvent(0, "DELTA", "d0")).reason, "DELTA_BEFORE_SNAPSHOT");
  assert.equal(runtime.applyStreamEvent(streamEvent(2, "SNAPSHOT", "s2")).reason, "GAP");
  assert.deepEqual(runtime.applyStreamEvent(streamEvent(2, "SNAPSHOT", "repair")), { status: "APPLIED", streamId: "stream:repo", sequence: 2 });
  assert.equal(runtime.applyStreamEvent(streamEvent(2, "SNAPSHOT", "different")).reason, "CONFLICT");
  assert.deepEqual(runtime.applyStreamEvent(streamEvent(2, "SNAPSHOT", "repair-after-conflict")), { status: "APPLIED", streamId: "stream:repo", sequence: 2 });
  assert.equal(runtime.applyStreamEvent(streamEvent(1, "DELTA", "late")).reason, "REORDERED");
  assert.equal(instrumentation.snapshot().eventRepairs, 4);
});

test("runtime scopes stream identity to its tenant", () => {
  const runtime = new PremiseRuntime({ tenantId: "tenant:stream", now: () => at });
  assert.throws(() => runtime.applyStreamEvent(streamEvent(0, "SNAPSHOT", "a1", { tenantId: "tenant:other" })), /Tenant boundary/);
});
