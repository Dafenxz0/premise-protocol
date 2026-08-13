import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createIndependentSmart, independentSmartContract } from "./independent-smart.mjs";

const versionA = { scheme: "test", token: "a" };

test("IndependentSmart reuses a stable cache and validates after an event hint", async () => {
  const baseline = createIndependentSmart({ baseTtl: 10 });
  let reads = 0;
  const tools = {
    async read() { reads += 1; return { version: versionA, value: "a" }; },
    async actIfVersion(expectedVersion) { return { accepted: expectedVersion.token === "a" }; }
  };
  const task = { tenantId: "t", resourceId: "r", observedVersion: versionA, logicalTime: 0, risk: "LOW", action: { kind: "noop" } };
  const first = await baseline.execute(task, tools);
  const second = await baseline.execute({ ...task, logicalTime: 1 }, tools);
  const third = await baseline.execute({ ...task, logicalTime: 2, events: [{ resourceId: "r", version: { scheme: "test", token: "b" } }] }, tools);
  assert.equal(first.accepted, true);
  assert.equal(second.trace.reads, 0);
  assert.equal(third.trace.reads, 1);
  assert.equal(reads, 2);
});

test("IndependentSmart is a standalone baseline contract", () => {
  assert.equal(independentSmartContract.importsPremiseInternals, false);
  assert.match(independentSmartContract.name, /IndependentSmart/);
});

test("IndependentSmart has no PREMiSE implementation import", async () => {
  const source = await readFile(new URL("./independent-smart.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /@premise\/runtime-core|premise-policy|frontier-engine|premiseReceipt/);
});
