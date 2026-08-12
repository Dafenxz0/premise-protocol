import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

test("protocol conformance executes the closed premise/1 and evolution profiles", async () => {
  const { stdout } = await run(process.execPath, ["conformance/run.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    maxBuffer: 4 * 1024 * 1024
  });
  assert.match(stdout, /PREMiSE\/1 conformance: PASS \(9 vectors; TypeScript == Python == expected\)/);
  assert.match(stdout, /PREMiSE\/1 wire conformance: PASS \(5 vectors/);
  assert.match(stdout, /PREMiSE\/1\.1 wire conformance: PASS \(9 vectors/);
  assert.match(stdout, /PREMiSE premise\/1\.1 conformance: PASS \(8 vectors; TypeScript == Python == expected\)/);
  assert.match(stdout, /PREMiSE premise-guard\/1-rich conformance: PASS \(8 vectors; TypeScript == Python == expected\)/);
  assert.match(stdout, /PREMiSE premise-policy\/1 conformance: PASS \(11 vectors; TypeScript == Python == expected\)/);
  assert.match(stdout, /PREMiSE premise-policy\/1-supplemental conformance: PASS \(4 vectors; TypeScript == Python == expected\)/);
});
