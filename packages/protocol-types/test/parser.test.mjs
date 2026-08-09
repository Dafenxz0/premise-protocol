import assert from "node:assert/strict";
import { EnvelopeValidationError, parseMemoryEnvelope, usabilityForStatus } from "../dist/index.js";

const valid = {
  specVersion: "premise/0.1",
  memoryId: "memory:test",
  provenance: [{ sourceUri: "file:///tmp/example", observedAt: "2026-08-09T19:20:00Z" }],
  validity: { status: "FRESH", checkedAt: "2026-08-09T19:20:00Z", policy: "IMMUTABLE" },
  dependsOn: []
};

assert.equal(parseMemoryEnvelope(valid).memoryId, "memory:test");
assert.throws(() => parseMemoryEnvelope({ ...valid, validity: { ...valid.validity, policy: "TTL" } }), EnvelopeValidationError);
assert.equal(usabilityForStatus("FRESH"), "USABLE");
assert.equal(usabilityForStatus("STALE"), "REVALIDATE");
assert.equal(usabilityForStatus("INVALID"), "REJECT");
console.log("protocol-types parser tests passed");
