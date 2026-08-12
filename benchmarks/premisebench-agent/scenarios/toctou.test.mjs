import test from "node:test";
import assert from "node:assert/strict";
import { createFilesystemWorld } from "../worlds/filesystem.mjs";
import { makeTask } from "./tasks.mjs";

test("filesystem CAS rejects a source change during validation", async () => {
  const task = makeTask(3, 20260811);
  const world = await createFilesystemWorld(task);
  const initial = await world.read();
  await world.mutateExternally();
  const response = await world.actIfVersion(initial.version, { kind: "apply", value: task.initial.value, basedOnVersion: initial.version });
  assert.equal(response.accepted, false);
  assert.equal(response.reason, "VERSION_MISMATCH");
  const evaluation = await world.evaluate();
  assert.equal(evaluation.unsafe, false);
  await world.cleanup();
});

test("inventory reservation and invoice capture retry idempotently after a CAS conflict", async () => {
  const task = {
    taskId: "inventory-invoice-cas-retry",
    initial: { status: "active", value: "stock:1;invoice:inv-v1", revision: "v1" },
    mutation: { status: "active", value: "stock:0;invoice:inv-v2", revision: "v2" },
    mutationWindow: "during-write",
    family: "toctou"
  };
  const world = await createFilesystemWorld(task);
  let reads = 0;
  let writes = 0;
  const action = (snapshot) => ({
    kind: "apply",
    value: snapshot.content.value,
    basedOnVersion: snapshot.version,
    idempotencyKey: "reservation:inv-v2"
  });
  try {
    const first = await world.read();
    reads += 1;
    await world.mutateExternally();

    const rejected = await world.actIfVersion(first.version, action(first));
    writes += 1;
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, "VERSION_MISMATCH");

    const current = await world.read();
    reads += 1;
    const retried = await world.actIfVersion(current.version, action(current));
    writes += 1;
    assert.equal(retried.accepted, true);

    const evaluation = await world.evaluate();
    assert.deepEqual({ reads, writes, requests: reads + writes }, { reads: 2, writes: 2, requests: 4 });
    assert.equal(evaluation.mutationCount, 1);
    assert.equal(evaluation.actions.length, 2, "the conflict and retry must both be observable");
    assert.equal(evaluation.actions.filter(({ accepted }) => accepted).length, 1, "idempotent retry applies once");
    assert.equal(evaluation.actions.at(-1).idempotencyKey, "reservation:inv-v2");
    assert.equal(evaluation.unsafe, false);
    assert.equal(evaluation.correct, true);
  } finally {
    await world.cleanup();
  }
});

test("PR-481 retries only a stale HEAD and preserves the complete current gate set", async () => {
  const task = {
    taskId: "pr-481-round-8",
    initial: { head: "h1", ci: "SUCCESS", review: "APPROVED", protection: "ENABLED", mergeable: true },
    mutation: { head: "h2", ci: "SUCCESS", review: "APPROVED", protection: "ENABLED", mergeable: true },
    mutationWindow: "during-write",
    family: "toctou"
  };
  const world = await createFilesystemWorld({ ...task, initial: { status: "active", value: JSON.stringify(task.initial) }, mutation: { status: "active", value: JSON.stringify(task.mutation) } });
  let reads = 0;
  let writeIntents = 0;
  try {
    const first = await world.read();
    reads += 1;
    await world.mutateExternally();
    writeIntents += 1;
    const stale = await world.actIfVersion(first.version, { kind: "apply", value: first.content.value, basedOnVersion: first.version });
    assert.equal(stale.accepted, false);
    assert.equal(stale.reason, "VERSION_MISMATCH");
    const current = { content: stale.current, version: stale.currentVersion };
    writeIntents += 1;
    const retried = await world.actIfVersion(current.version, { kind: "apply", value: current.content.value, basedOnVersion: current.version });
    assert.equal(retried.accepted, true);
    assert.deepEqual(JSON.parse(current.content.value), task.mutation);
    assert.deepEqual({ requests: reads + writeIntents, reads, writeIntents }, { requests: 3, reads: 1, writeIntents: 2 });
  } finally {
    await world.cleanup();
  }
});

for (const [label, mutation] of [
  ["gates change with HEAD", { head: "h2", ci: "FAILURE", review: "APPROVED", protection: "ENABLED", mergeable: false }],
  ["current is incomplete", { head: "h2", ci: "SUCCESS" }],
  ["permissions are revoked", { head: "h2", ci: "SUCCESS", review: "APPROVED", protection: "DISABLED", mergeable: true }]
]) {
  test(`PR-481 adversarial ${label} is REJECT without retry`, async () => {
    const world = await createFilesystemWorld({
      taskId: `pr-481-${label}`,
      initial: { status: "active", value: "h1" },
      mutation: { status: "blocked", value: JSON.stringify(mutation) },
      mutationWindow: "during-write",
      family: "toctou"
    });
    try {
      const snapshot = await world.read();
      await world.mutateExternally();
      const result = await world.actIfVersion(snapshot.version, { kind: "reject", reason: "gates-invalid" });
      assert.equal(result.accepted, false);
      assert.equal(result.reason, "VERSION_MISMATCH");
      const evaluation = await world.evaluate();
      assert.equal(evaluation.actions.length, 1, "a rejected CAS must not be retried");
      assert.equal(evaluation.unsafe, false);
    } finally {
      await world.cleanup();
    }
  });
}
