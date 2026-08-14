import assert from "node:assert/strict";
import {
  assertAdapterCapabilities,
  assertConditionalActionCapability
} from "@premise/adapter-sdk";
import { premise } from "../packages/runtime-core/dist/index.js";

const observedAt = "2026-08-14T00:00:00.000Z";
const tenantId = "tenant:quickstart";
const version = { scheme: "quickstart", token: "v1" };

function evidence(resource) {
  return [{
    evidenceId: `evidence:${resource}`,
    sourceUri: resource,
    version,
    validator: { id: "quickstart", operation: "read" },
    observedAt
  }];
}

let conditionalActionCalls = 0;

// This is a small in-memory connector implementing @premise/adapter-sdk.
// A production adapter would replace only this object with real I/O and CAS.
const adapter = {
  capabilities() {
    return {
      contract: "premise-adapter/2",
      adapterId: "quickstart-memory",
      features: ["OBSERVE", "REVALIDATE", "CONDITIONAL_ACTION"]
    };
  },

  async observe({ tenantId: requestedTenant, resource }) {
    return {
      tenantId: requestedTenant,
      resource,
      value: { resource, status: "ready" },
      version,
      observedAt,
      evidence: evidence(resource)
    };
  },

  async revalidate({ evidence: currentEvidence, expectedVersion }) {
    return {
      result: "UNCHANGED",
      checkedAt: observedAt,
      version: expectedVersion ?? currentEvidence.version
    };
  },

  async conditionalAction({ expectedVersion, action }) {
    conditionalActionCalls += 1;
    return {
      accepted: expectedVersion.token === version.token,
      result: { action, status: "action-committed" }
    };
  }
};

const capabilities = assertAdapterCapabilities(adapter, ["OBSERVE", "REVALIDATE"]);
assertConditionalActionCapability(adapter);

const session = premise.session({ tenant: tenantId, adapter });
const source = await session.observe("quickstart://config");
const plan = await session.derive({ claim: "The config is ready to use", from: [source] });

assert.equal(session.check(plan).decision, "USABLE");
const committed = await session.act({ premise: plan, action: { type: "publish" } });
assert.equal(committed.accepted, true);
assert.equal(conditionalActionCalls, 1);

console.log(JSON.stringify({
  adapter: capabilities.adapterId,
  contract: capabilities.contract,
  decision: "USABLE",
  action: committed.result
}));
