import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

test("protocol conformance executes every separated profile", async () => {
  const { stdout } = await run(process.execPath, ["conformance/run.mjs"], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  assert.match(stdout, /PREMiSE\/1 wire conformance: PASS \(5 vectors/);
  assert.match(stdout, /PREMiSE\/1\.1 wire conformance: PASS \(9 vectors/);
  assert.match(stdout, /PREMiSE premise\/1\.1 conformance: PASS \(8 vectors/);
  assert.match(stdout, /PREMiSE premise-guard\/1-rich conformance: PASS \(8 vectors/);
  assert.match(stdout, /PREMiSE premise-policy\/1 conformance: PASS \(5 vectors/);
});
