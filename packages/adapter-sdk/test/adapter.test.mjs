import test from "node:test";
import assert from "node:assert/strict";
import { assertAdapterCapabilities, assertConditionalActionCapability } from "../dist/index.js";

const adapter = {
  capabilities: () => ({ contract: "premise-adapter/2", adapterId: "test", features: ["OBSERVE", "REVALIDATE", "CONDITIONAL_ACTION"] }),
  observe: async () => ({}),
  revalidate: async () => ({ result: "UNCHANGED", checkedAt: "2026-08-14T00:00:00Z" }),
  conditionalAction: async () => ({ accepted: true })
};

test("adapter capability negotiation is explicit", () => {
  assert.deepEqual(assertAdapterCapabilities(adapter), { contract: "premise-adapter/2", adapterId: "test", features: ["OBSERVE", "REVALIDATE", "CONDITIONAL_ACTION"] });
  assert.doesNotThrow(() => assertConditionalActionCapability(adapter));
  assert.throws(() => assertAdapterCapabilities({ ...adapter, capabilities: () => ({ contract: "premise-adapter/2", adapterId: "test", features: ["OBSERVE"] }) }), /REVALIDATE/);
});

test("declared conditional action must have an implementation", () => {
  assert.throws(() => assertConditionalActionCapability({ ...adapter, conditionalAction: undefined }), /not implemented/);
});
