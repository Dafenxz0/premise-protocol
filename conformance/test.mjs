import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
test("premise/1 cross-language conformance", async () => {
  const { stdout } = await run(process.execPath, ["conformance/run.mjs"], { cwd: fileURLToPath(new URL("..", import.meta.url)), maxBuffer: 1024 * 1024 });
  assert.match(stdout, /PREMiSE\/1 conformance: PASS/);
});
