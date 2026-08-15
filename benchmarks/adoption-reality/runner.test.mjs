import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_OUTPUT,
  overallStatus
} from "./runner.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RUNNER = fileURLToPath(new URL("./runner.mjs", import.meta.url));

function runRunner(environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [RUNNER], {
      cwd: ROOT,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

test("status aggregation is explicit about failures and opt-in checks", () => {
  const pass = { status: "PASS", executed: true };
  const notRun = { status: "NOT_RUN", executed: false };
  const fail = { status: "FAIL", executed: true };
  assert.equal(overallStatus({ node: pass, filesystem: pass, httpProcess: pass, postgres: notRun }), "PASS_WITH_NOT_RUN");
  assert.equal(overallStatus({ node: pass, filesystem: pass, httpProcess: pass, postgres: pass }), "PASS");
  assert.equal(overallStatus({ node: pass, filesystem: pass, httpProcess: fail, postgres: notRun }), "FAIL");
  assert.equal(overallStatus({ node: pass, filesystem: pass, postgres: notRun }), "FAIL");
});

test("runner executes real filesystem and HTTP child-process certification", { timeout: 30_000 }, async () => {
  const environment = { ...process.env };
  delete environment.POSTGRES_URL;
  const result = await runRunner(environment);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(await readFile(DEFAULT_OUTPUT, "utf8"));
  assert.equal(report.status, "PASS_WITH_NOT_RUN");
  assert.equal(report.runtime.nodeMajor, 24);
  assert.equal(report.checks.node.status, "PASS");

  const filesystem = report.checks.filesystem;
  assert.equal(filesystem?.status, "PASS");
  assert.equal(filesystem?.executed, true);
  assert.equal(filesystem?.evidence.realFilesystem, true);
  assert.deepEqual(filesystem?.evidence.operations, ["observe", "change", "delete", "recreate"]);
  assert.notEqual(filesystem?.evidence.versions.initial, filesystem?.evidence.versions.recreated);

  const http = report.checks.httpProcess;
  assert.equal(http?.status, "PASS");
  assert.equal(http?.evidence.realHttp, true);
  assert.equal(http?.evidence.realNodeProcess, true);
  assert.deepEqual(http?.evidence.operations, [
    "observe", "change", "reject-stale", "delete", "reject-unknown", "recreate", "kill", "restart"
  ]);
  assert.equal(http?.evidence.requests.stale.decision, "REJECT");
  assert.equal(http?.evidence.requests.unknown.decision, "REJECT");
  assert.equal(http?.evidence.process.unavailableAfterKill, true);
  assert.equal(http?.evidence.actionLog.entries, 1);

  const postgres = report.checks.postgres;
  assert.equal(postgres?.status, "NOT_RUN");
  assert.equal(postgres?.executed, false);
  assert.equal(report.assertions.allPassesExecuted, true);
  assert.equal(report.assertions.postgresMissingUrlIsNotRun, true);
  assert.equal(report.cleanup.exactTemporaryDirectoriesOnly, true);
});
