import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
test("premise/1 cross-language conformance", async () => {
  const { stdout } = await run(process.execPath, ["conformance/run.mjs"], { cwd: fileURLToPath(new URL("..", import.meta.url)), maxBuffer: 1024 * 1024 });
  const lines = stdout.trim().split(/\r?\n/);
  assert.match(stdout, /PREMiSE\/1 conformance: PASS \(9 vectors; TypeScript == Python == expected\)/);
  assert.match(stdout, /PREMiSE\/1 wire conformance: NOT_RUN \(5 vectors; no independent premise\/1 wire reference available\)/);
  assert.equal(lines.filter((line) => line.startsWith("✓ ")).length, 9);
  assert.equal(lines.filter((line) => line.startsWith("- wire/") && line.includes("NOT_RUN (no independent premise/1 wire reference available)")).length, 5);
});
