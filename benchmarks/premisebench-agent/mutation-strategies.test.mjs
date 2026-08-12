import assert from "node:assert/strict";
import test from "node:test";
import { mutationStrategies } from "./mutation-strategies.mjs";

const snapshot = { version: "v1", content: { status: "active", value: "safe" } };

function context({ forbidden = [] } = {}) {
  const calls = [];
  const failIfCalled = (name) => (...args) => {
    calls.push(name);
    if (forbidden.includes(name)) throw new Error(`${name} is not a capability of this arm`);
    return name === "sourceRead" ? snapshot : { accepted: true, kind: "apply" };
  };
  return {
    calls,
    memory: snapshot,
    act: failIfCalled("act"),
    actIfVersion: failIfCalled("actIfVersion"),
    sourceRead: failIfCalled("sourceRead")
  };
}

test("anonymous baseline capabilities stay disjoint from guarded PREMiSE operations", async () => {
  const basic = context({ forbidden: ["sourceRead", "actIfVersion"] });
  await mutationStrategies.basic.run(basic);
  assert.deepEqual(basic.calls, ["act"]);

  const conventional = context({ forbidden: ["actIfVersion"] });
  await mutationStrategies.conventional.run(conventional);
  assert.deepEqual(conventional.calls, ["sourceRead", "act"]);

  const premise = context({ forbidden: ["act"] });
  premise.checkEvidence = () => ({ state: "FRESH" });
  await mutationStrategies.premise.run(premise);
  assert.deepEqual(premise.calls, ["actIfVersion"]);
});
