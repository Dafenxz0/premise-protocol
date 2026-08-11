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
