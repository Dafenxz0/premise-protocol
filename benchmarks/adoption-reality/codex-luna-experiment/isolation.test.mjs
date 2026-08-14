import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runner = join(root, "benchmarks", "adoption-reality", "codex-luna-experiment", "runner.mjs");
const sentinel = "premise-sentinel-do-not-forward-7f44e8";

const result = await new Promise((resolvePromise, rejectPromise) => {
  const child = spawn(process.execPath, [runner, "--security-self-check"], {
    cwd: root,
    env: { ...process.env, PREMISE_SENTINEL_SECRET: sentinel },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", rejectPromise);
  child.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
});

assert.equal(result.code, 0, `credential isolation check failed: ${result.stderr}\n${result.stdout}`);
assert.doesNotMatch(result.stdout, new RegExp(sentinel, "u"));
assert.doesNotMatch(result.stderr, new RegExp(sentinel, "u"));
console.log("codex/luna credential isolation sentinel passed");
