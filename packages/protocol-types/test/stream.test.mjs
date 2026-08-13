import assert from "node:assert/strict";
import test from "node:test";
import {
  isV2EventStreamPage,
  isV2StreamCapability,
  parseV2EventStreamPage,
  parseV2StreamEvent,
  validateV2StreamEvent
} from "../dist/index.js";

const at = "2026-08-14T00:00:00Z";
const base = {
  specVersion: "premise/2",
  tenantId: "tenant:stream",
  eventId: "event:1",
  operationId: "op:1",
  idempotencyKey: "idem:1",
  requestDigest: `sha256:${"a".repeat(64)}`,
  type: "SourceChanged",
  occurredAt: at,
  payload: { sourceUri: "source://repo", version: { scheme: "git", token: "a1" } }
};

test("stream events add ordered metadata without changing V2Event fields", () => {
  const snapshot = parseV2StreamEvent({ ...base, streamId: "stream:repo", sequence: 0, kind: "SNAPSHOT", cursor: "c0" });
  const delta = parseV2StreamEvent({ ...base, eventId: "event:2", operationId: "op:2", idempotencyKey: "idem:2", requestDigest: `sha256:${"b".repeat(64)}`, streamId: "stream:repo", sequence: 1, kind: "DELTA", cursor: "c1" });
  assert.equal(snapshot.kind, "SNAPSHOT");
  assert.equal(delta.sequence, 1);
  assert.equal(validateV2StreamEvent({ ...base, streamId: "stream:repo", sequence: 0, kind: "DELTA", unknown: true }).some(({ path }) => path === "$.unknown"), true);
});

test("event pages enforce stream identity and head sequence", () => {
  const page = parseV2EventStreamPage({
    streamId: "stream:repo",
    specVersion: "premise/2",
    tenantId: "tenant:stream",
    events: [{ ...base, streamId: "stream:repo", sequence: 0, kind: "SNAPSHOT" }],
    headSequence: 0,
    nextCursor: "c1"
  });
  assert.equal(isV2EventStreamPage(page), true);
  assert.equal(isV2EventStreamPage({ ...page, events: [{ ...page.events[0], streamId: "stream:other" }] }), false);
  assert.equal(isV2EventStreamPage({ ...page, events: [{ ...page.events[0], tenantId: "tenant:other" }] }), false);
  assert.throws(() => parseV2EventStreamPage({ ...page, headSequence: -1 }), (error) => error.issues.some(({ path }) => path === "$.headSequence"));
});

test("stream capabilities remain an explicit negotiation", () => {
  assert.equal(isV2StreamCapability("ORDERED_EVENTS"), true);
  assert.equal(isV2StreamCapability("UNVERIFIED_PUSH"), false);
});
