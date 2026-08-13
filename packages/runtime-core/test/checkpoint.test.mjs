import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeCheckpoint,
  parseRuntimeCheckpoint,
  runtimeCheckpointDigest,
  verifyRuntimeCheckpointRecovery
} from "../dist/index.js";

const at = "2026-08-13T00:00:00Z";
const input = {
  format: "premise-runtime-checkpoint",
  version: 1,
  capturedAt: at,
  activeRecords: [{ memoryId: "memory:1", content: { ok: true } }],
  frontierState: { nodes: ["memory:1"], status: "FRESH" },
  incarnations: { "memory:1": "inc:1" },
  eventCursor: 4,
  receiptEpoch: 2,
  idempotencyState: { "op:1": "DONE" },
  sourceVersions: { "file:///config": "v4" },
  dependencyState: { "memory:1": [] }
};

test("checkpoint round-trips with a deterministic digest", () => {
  const checkpoint = createRuntimeCheckpoint(input);
  assert.equal(checkpoint.digest, runtimeCheckpointDigest(input));
  assert.deepEqual(parseRuntimeCheckpoint(checkpoint), checkpoint);
});

test("checkpoint rejects tampering and incomplete operational state", () => {
  const checkpoint = createRuntimeCheckpoint(input);
  assert.throws(() => parseRuntimeCheckpoint({ ...checkpoint, sourceVersions: { "file:///config": "v5" } }), /digest mismatch/);
  assert.throws(() => createRuntimeCheckpoint({ ...input, eventCursor: -1 }), /eventCursor/);
  assert.throws(() => createRuntimeCheckpoint({ ...input, activeRecords: undefined }), /activeRecords/);
});

test("checkpoint recovery accepts an exact tail and fails closed on gaps or reorder", () => {
  const checkpoint = createRuntimeCheckpoint(input);
  assert.deepEqual(verifyRuntimeCheckpointRecovery(checkpoint, [{ cursor: 5 }, { cursor: 6 }]), { status: "READY", checkpoint, finalCursor: 6 });
  assert.equal(verifyRuntimeCheckpointRecovery(checkpoint, [{ cursor: 6 }]).reason, "TAIL_GAP");
  assert.equal(verifyRuntimeCheckpointRecovery(checkpoint, [{ cursor: 5 }, { cursor: 5 }]).reason, "TAIL_REORDERED");
  assert.equal(verifyRuntimeCheckpointRecovery(checkpoint, [{ cursor: -1 }]).reason, "TAIL_CURSOR");
});
