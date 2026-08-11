import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFilesystemWorld } from "../benchmarks/premisebench-agent/worlds/filesystem.mjs";
import { makeTask } from "../benchmarks/premisebench-agent/scenarios/tasks.mjs";
import { InMemoryRuntimeStore, PremiseRuntime } from "../packages/runtime-core/dist/index.js";

const at = "2026-08-11T10:00:00Z";
const vectors = Object.fromEntries(await Promise.all([
  "fresh-use.json",
  "stale-version.json",
  "toctou-rejection.json"
].map(async (name) => [name, JSON.parse(await readFile(new URL(`../spec/premise-1/vectors/${name}`, import.meta.url), "utf8"))])));

function envelope(memoryId, status = "FRESH", sourceUri = "source://config", dependsOn = []) {
  return {
    specVersion: "premise/2",
    tenantId: "team-a",
    memoryId,
    evidence: dependsOn.length === 0 ? [{ evidenceId: `${memoryId}:e`, sourceUri, observedAt: at, version: { scheme: "revision", token: "v1" }, validator: { id: "config", operation: "read" } }] : [],
    confidence: { score: null, method: "test", assessedAt: at },
    conflicts: [],
    temporal: { asOf: at },
    validity: { status, checkedAt: at, policy: "VERSIONED" },
    dependsOn,
    signatures: []
  };
}

test("fresh memory is used without a revalidation, and a changed source stales its closure", async () => {
  assert.equal(vectors["fresh-use.json"].expected.decision, "USE");
  assert.equal(vectors["stale-version.json"].expected.decision, "REVALIDATE");

  const runtime = new PremiseRuntime({ tenantId: "team-a", now: () => at });
  runtime.register({ envelope: envelope("memory:source"), content: { value: "safe" } });
  runtime.derive({ envelope: envelope("memory:derived", "FRESH", "source://derived", ["memory:source"]), content: { value: "safe-derived" } });

  let validations = 0;
  const use = async (memoryId) => {
    const decision = runtime.check([memoryId])[0];
    if (decision.decision === "REVALIDATE") {
      validations += 1;
      await runtime.revalidate(memoryId, async () => ({ memoryId, result: "UNCHANGED", status: "FRESH", checkedAt: at }));
    }
    return decision.decision === "USABLE";
  };

  assert.equal(await use("memory:source"), true);
  assert.equal(validations, 0, "FRESH must not trigger revalidation");
  const beforeCheck = runtime.eventCount();
  assert.equal(runtime.check(["memory:source"])[0].decision, "USABLE");
  assert.equal(runtime.eventCount(), beforeCheck, "check must remain read-only");

  assert.deepEqual(runtime.signalSourceChanged("source://config", { scheme: "revision", token: "v2" }), ["memory:source", "memory:derived"]);
  assert.deepEqual(runtime.check(["memory:source", "memory:derived"]).map(({ status, decision }) => ({ status, decision })), [
    { status: "STALE", decision: "REVALIDATE" },
    { status: "STALE", decision: "REVALIDATE" }
  ]);
});

test("CAS rejects a TOCTOU source change without applying the action", async () => {
  assert.equal(vectors["toctou-rejection.json"].expected.toctouEscaped, false);
  const task = makeTask(3, 20260811);
  const world = await createFilesystemWorld(task);
  try {
    const snapshot = await world.read();
    await world.mutateExternally();
    const response = await world.actIfVersion(snapshot.version, {
      kind: "apply",
      value: snapshot.content.value,
      basedOnVersion: snapshot.version
    });
    assert.equal(response.accepted, false);
    assert.equal(response.reason, "VERSION_MISMATCH");
    const evaluation = await world.evaluate();
    assert.equal(evaluation.unsafe, false);
    assert.equal(evaluation.action, null, "rejected CAS must not record an applied action");
  } finally {
    await world.cleanup();
  }
});

test("runtime source invalidation remains efficient with indexed storage", () => {
  const store = new InMemoryRuntimeStore();
  const runtime = new PremiseRuntime({ store, tenantId: "team-a", now: () => at });
  runtime.register({ envelope: envelope("memory:indexed"), content: { value: "safe" } });
  const before = store.revision;
  runtime.signalSourceChanged("source://unrelated", { scheme: "revision", token: "v2" });
  assert.equal(store.revision, before, "unrelated source changes must not rewrite records");
});
