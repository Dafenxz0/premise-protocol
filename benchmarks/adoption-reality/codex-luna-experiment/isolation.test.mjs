import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runner = join(root, "benchmarks", "adoption-reality", "codex-luna-experiment", "runner.mjs");
const sentinel = "premise-parent-secret-must-not-forward-7f44e8";

async function runCheck(argument) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [runner, argument], {
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
    child.on("close", (code, signal) => resolvePromise({ argument, code, signal, stdout, stderr }));
  });
}

for (const argument of ["--security-self-check", "--candidate-smoke-self-check"]) {
  const result = await runCheck(argument);
  assert.equal(result.code, 0, `${argument} failed: ${result.stderr}\n${result.stdout}`);
  assert.doesNotMatch(result.stdout, new RegExp(sentinel, "u"));
  assert.doesNotMatch(result.stderr, new RegExp(sentinel, "u"));
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "PASS", `${argument} did not report PASS`);
  assert.equal(report.success, true, `${argument} did not report success`);
  assert.equal(report.credentialExposed, false, `${argument} exposed the parent sentinel`);
}
console.log("codex/luna credential isolation sentinels passed for agent and candidate smoke");
