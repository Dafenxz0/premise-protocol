import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryRuntimeStore, PremiseRuntime, planRuntimeStreamBurst } from "../dist/index.js";

const at = "2026-08-14T00:00:00Z";
const streamEvent = (sequence, kind, token) => ({
  specVersion: "premise/2",
  tenantId: "tenant:stream",
  eventId: `burst:${sequence}:${token}`,
  operationId: `burst-op:${sequence}:${token}`,
  idempotencyKey: `burst-idem:${sequence}:${token}`,
  requestDigest: `sha256:${token.padEnd(64, "a").slice(0, 64)}`,
  type: "SourceChanged",
  occurredAt: at,
  payload: { sourceUri: "source://repo", version: { scheme: "git", token } },
  streamId: "stream:repo",
  sequence,
  kind,
  cursor: `cursor:${sequence}`
});

const capabilities = { capabilities: ["ORDERED_EVENTS", "AUTHORITATIVE_SNAPSHOT", "DELTA_EVENTS", "DUPLICATE_SAFE"] };

test("burst planner drops only the prefix covered by a later authoritative snapshot", () => {
  const plan = planRuntimeStreamBurst([
    streamEvent(10, "DELTA", "d10"),
    streamEvent(11, "SNAPSHOT", "s11"),
    streamEvent(12, "DELTA", "d12")
  ], capabilities);
  assert.deepEqual(plan, {
    status: "COALESCED",
    streamId: "stream:repo",
    tenantId: "tenant:stream",
    events: [streamEvent(11, "SNAPSHOT", "s11"), streamEvent(12, "DELTA", "d12")],
    skippedSequences: [10]
  });
});

test("delta-only or capability-poor bursts are preserved", () => {
  assert.equal(planRuntimeStreamBurst([streamEvent(10, "DELTA", "d10"), streamEvent(11, "DELTA", "d11")], capabilities).status, "PRESERVED");
  assert.equal(planRuntimeStreamBurst([streamEvent(10, "DELTA", "d10"), streamEvent(11, "SNAPSHOT", "s11")], { capabilities: ["ORDERED_EVENTS"] }).reason, "CAPABILITY_MISSING");
  assert.equal(planRuntimeStreamBurst([streamEvent(10, "DELTA", "d10"), streamEvent(12, "SNAPSHOT", "s12")], capabilities).reason, "NON_CONTIGUOUS");
});

test("runtime applies coalesced bursts through authoritative repair", () => {
  const runtime = new PremiseRuntime({ store: new InMemoryRuntimeStore(), tenantId: "tenant:stream", now: () => at });
  assert.deepEqual(runtime.applyStreamBurst([
    streamEvent(10, "DELTA", "d10"),
    streamEvent(11, "SNAPSHOT", "s11"),
    streamEvent(12, "DELTA", "d12")
  ], capabilities), {
    status: "REPAIRED",
    coalesced: true,
    applied: [11, 12],
    duplicates: [],
    skippedSequences: [10]
  });
  assert.equal(runtime.eventCount(), 2, "the coalesced prefix must not be persisted");
});
