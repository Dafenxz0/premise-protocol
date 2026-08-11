import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { makeTask } from "../scenarios/tasks.mjs";
import { createFilesystemWorld } from "../worlds/filesystem.mjs";
import { runExternalCandidate } from "./runner.mjs";

test("external candidate completes through the tool boundary", async () => {
  const task = makeTask(1, 20260811);
  const world = await createFilesystemWorld(task);
  const initial = await world.read();
  await world.mutateExternally();
  const candidate = resolve(fileURLToPath(new URL("./candidate.mjs", import.meta.url)));
  const result = await runExternalCandidate({ command: [process.execPath, candidate], task, initial, world });
  assert.equal(result.messages.some((message) => message.type === "actIfVersion"), true);
  assert.equal((await world.evaluate()).unsafe, false);
  await world.cleanup();
});
