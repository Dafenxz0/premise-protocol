import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FORMAT = "premise-adoption-reality-certification/1";
export const NODE_REQUIRED_MAJOR = 24;
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const REPORT_PATH = join(REPOSITORY_ROOT, ".tmp", "adoption-reality", "certification.json");
export const DEFAULT_OUTPUT = REPORT_PATH;

const TARGET_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const FILESYSTEM_PROBE = join(TARGET_DIRECTORY, "fixtures", "filesystem-probe.mjs");
const HTTP_SERVER = join(TARGET_DIRECTORY, "fixtures", "http-source-server.mjs");
const POSTGRES_PROBE = join(TARGET_DIRECTORY, "fixtures", "postgres-fixture.mjs");
const REQUIRED_CHECKS = Object.freeze(["node", "filesystem", "httpProcess"]);

export function isNode24(value = process.versions.node) {
  const match = /^v?(\d+)/u.exec(String(value));
  return match !== null && Number(match[1]) === NODE_REQUIRED_MAJOR;
}

function nodeInfo() {
  return {
    version: process.version,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    platform: platform(),
    arch: arch(),
    executable: process.execPath,
    pid: process.pid
  };
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function assertCondition(condition, text) {
  assert.equal(condition, true, text);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceText(resourceId, revision, value, incarnationId = "incarnation:1") {
  return `${JSON.stringify({ resourceId, revision, value, incarnationId }, null, 2)}\n`;
}

async function writeSource(file, resourceId, revision, value, incarnationId = "incarnation:1") {
  const text = sourceText(resourceId, revision, value, incarnationId);
  await writeFile(file, text, "utf8");
  return { bytes: Buffer.byteLength(text), version: sha256(Buffer.from(text, "utf8")) };
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function closeResult(child) {
  if (exited(child)) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolvePromise) => child.once("close", (code, signal) => resolvePromise({ code, signal })));
}

async function waitForExit(child, timeoutMs = 5_000) {
  let timer;
  const timeout = new Promise((resolvePromise) => {
    timer = setTimeout(() => resolvePromise({ timedOut: true }), timeoutMs);
    timer.unref();
  });
  const result = await Promise.race([closeResult(child), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (!result.timedOut) return { ...result, exited: true };
  try { child.kill("SIGKILL"); } catch { /* the process may have exited during the timeout race */ }
  return { ...(await closeResult(child)), exited: true, forced: true };
}

async function stop(child) {
  if (!exited(child)) {
    try { child.kill(); } catch { /* cleanup observes the exit race */ }
  }
  return waitForExit(child);
}

async function runJsonProcess(script, args, options = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: REPOSITORY_ROOT,
    env: options.env ?? { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await waitForExit(child, options.timeoutMs ?? 5_000);
  if (result.forced === true) throw new Error(`${options.label ?? "child process"} timed out`);
  const prefix = options.prefix ?? "";
  const line = stdout.split(/\r?\n/u).map((value) => value.trim()).find((value) => value.startsWith(prefix));
  if (line === undefined) throw new Error(`${options.label ?? "child process"} emitted no JSON (exit=${result.code ?? "none"}; stderr=${stderr.trim()})`);
  let value;
  try { value = JSON.parse(line.slice(prefix.length)); } catch (error) {
    throw new Error(`${options.label ?? "child process"} emitted invalid JSON: ${message(error)}`);
  }
  assertCondition(result.code === 0, `${options.label ?? "child process"} exited with code ${result.code}`);
  assertCondition(isNode24(value.nodeVersion ?? value.node), `${options.label ?? "child process"} must run on Node 24`);
  return { value, pid: child.pid, exit: result };
}

async function startHttpServer(sourceFile, actionLog, port = 0) {
  const child = spawn(process.execPath, [
    HTTP_SERVER,
    "--source-file", sourceFile,
    "--action-log", actionLog,
    "--port", String(port)
  ], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  let resolveReady;
  let rejectReady;
  let settled = false;
  const ready = new Promise((resolvePromise, reject) => {
    resolveReady = resolvePromise;
    rejectReady = reject;
  });
  const onData = (chunk) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/u);
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) continue;
      try {
        const event = JSON.parse(line);
        if (!settled && event.event === "ready") {
          settled = true;
          resolveReady(event);
        }
      } catch {
        // The fixture only emits JSON; non-JSON output is retained for diagnostics.
      }
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", onData);
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => {
    if (!settled) {
      settled = true;
      rejectReady(error);
    }
  });
  child.once("exit", (code, signal) => {
    if (!settled) {
      settled = true;
      rejectReady(new Error(`HTTP child exited before readiness (code=${code}, signal=${signal ?? "none"})`));
    }
  });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("HTTP child readiness timed out")), 5_000);
    timer.unref();
  });
  try {
    const event = await Promise.race([ready, timeout]);
    assertCondition(Number(event.port) > 0, "HTTP child must bind a real TCP port");
    assertCondition(isNode24(event.nodeVersion), "HTTP child must run on Node 24");
    return {
      child,
      pid: child.pid,
      port: event.port,
      processIncarnation: event.processIncarnation,
      nodeVersion: event.nodeVersion,
      baseUrl: `http://127.0.0.1:${event.port}`,
      logs: () => ({ stdout, stderr })
    };
  } catch (error) {
    await stop(child);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function requestJson(server, method, path, body, timeoutMs = 3_000) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  return { method, path, status: response.status, body: value, pid: server.pid, processIncarnation: server.processIncarnation };
}

function checkPass(id, started, evidence) {
  assertCondition(evidence?.executed === true, `${id} cannot be PASS without executing`);
  return { id, status: "PASS", executed: true, durationMs: Date.now() - started, evidence };
}

async function executeCheck(id, operation) {
  const started = Date.now();
  try {
    return checkPass(id, started, await operation());
  } catch (error) {
    return { id, status: "FAIL", executed: true, durationMs: Date.now() - started, error: message(error) };
  }
}

async function filesystemCheck() {
  const root = await mkdtemp(join(tmpdir(), "premise-adoption-reality-filesystem-"));
  try {
    const file = join(root, "source.json");
    const initial = await writeSource(file, "file:adoption:1", 1, "before", "incarnation:1");
    const observed = await runJsonProcess(FILESYSTEM_PROBE, ["--file", file], { label: "filesystem probe" });
    assertCondition(observed.value.status === "PRESENT", "filesystem probe must observe the initial file");
    assertCondition(observed.value.version.token === initial.version, "filesystem probe must hash the actual file");
    const changed = await writeSource(file, "file:adoption:1", 2, "changed", "incarnation:1");
    const changedProbe = await runJsonProcess(FILESYSTEM_PROBE, ["--file", file], { label: "changed filesystem probe" });
    assertCondition(changedProbe.value.status === "PRESENT", "filesystem probe must observe a changed file");
    assertCondition(changedProbe.value.version.token === changed.version && changed.version !== initial.version, "file change must produce a new version");
    await rm(file, { force: false });
    const missingProbe = await runJsonProcess(FILESYSTEM_PROBE, ["--file", file], { label: "deleted filesystem probe" });
    assertCondition(missingProbe.value.status === "MISSING", "filesystem probe must observe deletion");
    const recreated = await writeSource(file, "file:adoption:1", 3, "recreated", "incarnation:2");
    const recreatedProbe = await runJsonProcess(FILESYSTEM_PROBE, ["--file", file], { label: "recreated filesystem probe" });
    assertCondition(recreatedProbe.value.status === "PRESENT", "filesystem probe must observe recreation");
    assertCondition(recreatedProbe.value.version.token === recreated.version && recreated.version !== changed.version, "recreation must produce a new version");
    assertCondition(await exists(file), "recreated source must exist on disk");
    return {
      executed: true,
      childProcess: true,
      realFilesystem: true,
      operations: ["observe", "change", "delete", "recreate"],
      process: { pids: [observed.pid, changedProbe.pid, missingProbe.pid, recreatedProbe.pid], node: process.version },
      versions: { initial: initial.version, changed: changed.version, recreated: recreated.version },
      transition: {
        operation: "change",
        versionChanged: changed.version !== initial.version,
        deletedStatus: 404,
        oldIncarnation: "incarnation:1",
        newIncarnation: "incarnation:2"
      },
      temporaryDirectory: "premise-adoption-reality-filesystem-*"
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function httpProcessCheck() {
  const root = await mkdtemp(join(tmpdir(), "premise-adoption-reality-http-"));
  const sourceFile = join(root, "source.json");
  const actionLog = join(root, "actions.ndjson");
  await writeSource(sourceFile, "http:adoption:1", 1, "before");
  let server;
  try {
    server = await startHttpServer(sourceFile, actionLog);
    const initial = await requestJson(server, "GET", "/state");
    assertCondition(initial.status === 200, "HTTP child must expose the initial source");
    const health = await requestJson(server, "GET", "/health");
    assertCondition(health.status === 200 && health.body.ok === true, "HTTP child must expose health");
    const initialVersion = initial.body.version.token;

    await writeSource(sourceFile, "http:adoption:1", 2, "changed");
    const changed = await requestJson(server, "GET", "/state");
    assertCondition(changed.status === 200 && changed.body.version.token !== initialVersion, "HTTP child must observe a real file change");
    const stale = await requestJson(server, "POST", "/guard", { expectedVersion: initialVersion, actionId: "stale-action" });
    assertCondition(stale.status === 409 && stale.body.status === "STALE" && stale.body.decision === "REJECT", "stale action must be rejected");

    await rm(sourceFile, { force: false });
    assertCondition(await exists(sourceFile) === false, "HTTP delete step must remove the real file");
    const deleted = await requestJson(server, "GET", "/state");
    assertCondition(deleted.status === 404, "deleted source must be unknown over HTTP");
    const unknown = await requestJson(server, "POST", "/guard", { expectedVersion: changed.body.version.token, actionId: "unknown-action" });
    assertCondition(unknown.status === 503 && unknown.body.status === "UNKNOWN" && unknown.body.decision === "REJECT", "unknown source must reject an action");

    await writeSource(sourceFile, "http:adoption:1", 3, "recreated", "incarnation:2");
    const recreated = await requestJson(server, "GET", "/state");
    assertCondition(recreated.status === 200 && recreated.body.revision === 3, "recreated source must be observable");
    assertCondition(recreated.body.incarnationId !== initial.body.incarnationId, "recreated source must have a new incarnation");
    const allowed = await requestJson(server, "POST", "/guard", { expectedVersion: recreated.body.version.token, actionId: "fresh-action" });
    assertCondition(allowed.status === 200 && allowed.body.decision === "ALLOW", "fresh action must be allowed by the fixture guard");

    const oldServer = server;
    const oldPort = server.port;
    const oldPid = server.pid;
    const oldIncarnation = server.processIncarnation;
    const killRequested = server.child.kill();
    const stopped = await waitForExit(server.child);
    server = undefined;
    assertCondition(killRequested === true && stopped.exited === true, "HTTP child must be killed before restart");
    let unavailableAfterKill = false;
    try {
      await requestJson(oldServer, "GET", "/health", undefined, 1_000);
    } catch {
      unavailableAfterKill = true;
    }
    assertCondition(unavailableAfterKill, "HTTP endpoint must be unavailable after child kill");

    server = await startHttpServer(sourceFile, actionLog, oldPort);
    const restarted = await requestJson(server, "GET", "/state");
    assertCondition(restarted.status === 200, "restarted HTTP child must be reachable");
    assertCondition(restarted.body.version.token === recreated.body.version.token, "restart must preserve filesystem state");
    assertCondition(server.pid !== oldPid && server.processIncarnation !== oldIncarnation, "restart must create a new process incarnation");
    const actions = (await readFile(actionLog, "utf8")).trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    assertCondition(actions.length === 1 && actions[0].actionId === "fresh-action", "rejected stale/unknown actions must not write effects");
    return {
      executed: true,
      childProcess: true,
      realFilesystem: true,
      realHttp: true,
      operations: ["observe", "change", "reject-stale", "delete", "reject-unknown", "recreate", "kill", "restart"],
      requests: {
        initial: { status: initial.status, version: initialVersion },
        changed: { status: changed.status, version: changed.body.version.token },
        stale: { status: stale.status, decision: stale.body.decision },
        deleted: { status: deleted.status },
        unknown: { status: unknown.status, decision: unknown.body.decision },
        recreated: { status: recreated.status, version: recreated.body.version.token },
        allowed: { status: allowed.status, decision: allowed.body.decision },
        restarted: { status: restarted.status, version: restarted.body.version.token }
      },
      process: {
        firstPid: oldPid,
        restartedPid: server.pid,
        firstIncarnation: oldIncarnation,
        restartedIncarnation: server.processIncarnation,
        killRequested,
        exitedAfterKill: stopped.exited,
        kill: { requested: killRequested, exited: stopped.exited, code: stopped.code, signal: stopped.signal },
        unavailableAfterKill
      },
      transition: {
        operation: "kill-restart",
        filesystemSurvived: restarted.body.version.token === recreated.body.version.token,
        processChanged: server.pid !== oldPid
      },
      realNodeProcess: true,
      actionLog: { entries: actions.length, rejectedActionsProducedNoEntry: true },
      temporaryDirectory: "premise-adoption-reality-http-*"
    };
  } finally {
    if (server !== undefined) await stop(server.child);
    await rm(root, { recursive: true, force: true });
  }
}

export function skippedCheck(id, reason) {
  return { id, status: "NOT_RUN", executed: false, optional: true, reason };
}

export function postgresStatusIsNotRun(check) {
  return check?.status === "NOT_RUN" && check?.executed === false;
}

async function postgresCheck() {
  if (typeof process.env.POSTGRES_URL !== "string" || process.env.POSTGRES_URL.length === 0) {
    return skippedCheck("postgres", "POSTGRES_URL is not configured");
  }
  const started = Date.now();
  try {
    const probe = await runJsonProcess(POSTGRES_PROBE, ["--probe-name", `adoption-reality-${process.pid}-${randomUUID()}`], {
      label: "PostgreSQL probe",
      prefix: "RESULT ",
      timeoutMs: 15_000,
      env: { ...process.env }
    });
    if (probe.value.status !== "PASS") {
      return { id: "postgres", status: "FAIL", executed: true, durationMs: Date.now() - started, reason: probe.value.reason ?? "PostgreSQL probe did not pass" };
    }
    assertCondition(probe.value.executed === true && probe.value.realPostgres === true && probe.value.readOnly === true, "PostgreSQL PASS requires real read-only evidence");
    return {
      id: "postgres",
      status: "PASS",
      executed: true,
      durationMs: Date.now() - started,
      evidence: { childProcess: true, realPostgres: true, readOnly: true, process: { pid: probe.value.processId, node: probe.value.node }, query: probe.value.query, rowCount: probe.value.rowCount }
    };
  } catch (error) {
    return { id: "postgres", status: "FAIL", executed: true, durationMs: Date.now() - started, error: message(error) };
  }
}

export function overallStatus(checks) {
  if (checks !== null && typeof checks === "object" && "total" in checks && "pass" in checks) {
    if (checks.fail > 0) return "FAIL";
    if (checks.pass === 0) return "NOT_RUN";
    if (checks.notRun > 0) return "PASS_WITH_NOT_RUN";
    return "PASS";
  }
  const entries = Object.values(checks ?? {});
  const required = REQUIRED_CHECKS.map((id) => checks?.[id]).filter(Boolean);
  if (required.length !== REQUIRED_CHECKS.length) return "FAIL";
  if (required.some((check) => check.status !== "PASS" || check.executed !== true)) return "FAIL";
  const postgres = checks?.postgres;
  if (postgres !== undefined && postgres.status === "FAIL") return "FAIL";
  if (entries.some((check) => check.status === "PASS" && check.executed !== true)) return "FAIL";
  if (postgres !== undefined && postgres.status === "NOT_RUN") return "PASS_WITH_NOT_RUN";
  return "PASS";
}

function scenarioSummary(scenarios) {
  const summary = { total: scenarios.length, pass: 0, fail: 0, notRun: 0 };
  for (const scenario of scenarios) {
    if (scenario.status === "PASS") summary.pass += 1;
    else if (scenario.status === "FAIL") summary.fail += 1;
    else if (scenario.status === "NOT_RUN") summary.notRun += 1;
  }
  return summary;
}

function scenarioFromCheck(id, check, evidence) {
  if (check.status === "PASS") return { id, status: "PASS", executed: true, durationMs: check.durationMs, evidence };
  return { id, status: check.status, executed: check.executed === true, durationMs: check.durationMs, ...(check.reason === undefined ? {} : { reason: check.reason }), ...(check.error === undefined ? {} : { error: check.error }) };
}

function assertionsFor(checks) {
  const entries = Object.values(checks);
  return {
    allPassesExecuted: entries.filter((check) => check.status === "PASS").every((check) => check.executed === true),
    postgresMissingUrlIsNotRun: process.env.POSTGRES_URL === undefined || postgresStatusIsNotRun(checks.postgres)
  };
}

export async function runCertification() {
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  const runtime = nodeInfo();
  const checks = {
    node: isNode24(runtime.version)
      ? { id: "node", status: "PASS", executed: true, evidence: { realProcess: true, pid: runtime.pid, node: runtime.version, executable: runtime.executable } }
      : { id: "node", status: "FAIL", executed: true, reason: `Node 24 is required; found ${runtime.version}` }
  };
  const scenarios = [];
  if (checks.node.status === "PASS") {
    checks.filesystem = await executeCheck("filesystem", filesystemCheck);
    scenarios.push(scenarioFromCheck("filesystem-change", checks.filesystem, checks.filesystem.evidence));
    scenarios.push(scenarioFromCheck("filesystem-delete-recreate", checks.filesystem, checks.filesystem.evidence));
    checks.httpProcess = await executeCheck("httpProcess", httpProcessCheck);
    scenarios.push(scenarioFromCheck("http-child-process-kill-restart", checks.httpProcess, checks.httpProcess.evidence));
    checks.postgres = await postgresCheck();
    scenarios.push(checks.postgres);
  } else {
    checks.filesystem = skippedCheck("filesystem", "Node 24 runtime gate failed");
    checks.httpProcess = skippedCheck("httpProcess", "Node 24 runtime gate failed");
    checks.postgres = skippedCheck("postgres", "Node 24 runtime gate failed");
    scenarios.push(skippedCheck("filesystem-change", "Node 24 runtime gate failed"));
    scenarios.push(skippedCheck("filesystem-delete-recreate", "Node 24 runtime gate failed"));
    scenarios.push(skippedCheck("http-child-process-kill-restart", "Node 24 runtime gate failed"));
    scenarios.push(checks.postgres);
  }
  const summary = scenarioSummary(scenarios);
  if (checks.node.status === "FAIL") summary.fail += 1;
  const assertions = {
    ...assertionsFor(checks),
    allPassesExecuted: scenarios.filter((scenario) => scenario.status === "PASS").every((scenario) => scenario.executed === true),
    postgresMissingUrlIsNotRun: process.env.POSTGRES_URL === undefined ? postgresStatusIsNotRun(checks.postgres) : true
  };
  const status = overallStatus(summary);
  const report = {
    format: FORMAT,
    benchmark: "adoption-reality",
    generatedAt: new Date().toISOString(),
    runId: randomUUID(),
    runtime,
    runner: { node: runtime.version, node24: isNode24(runtime.version), platform: runtime.platform, arch: runtime.arch, executable: runtime.executable },
    status,
    summary,
    scenarios,
    checks,
    assertions,
    cleanup: {
      exactTemporaryDirectoriesOnly: true,
      exactTemporaryRunDirectoryRemoved: true,
      filesystemPrefix: "premise-adoption-reality-filesystem-",
      httpPrefix: "premise-adoption-reality-http-",
      reportRetained: true
    },
    limitations: [
      "Filesystem and HTTP evidence is local disposable-process evidence, not production availability or throughput evidence.",
      "The HTTP fixture proves stale/unknown rejection and process restart for this controlled source; it is not a third-party connector guarantee.",
      "PostgreSQL is opt-in through POSTGRES_URL and uses only a real read-only probe; missing configuration is NOT_RUN, never PASS."
    ]
  };
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function printHelp() {
  console.log("Usage: node benchmarks/adoption-reality/runner.mjs");
  console.log("POSTGRES_URL is optional; without it the PostgreSQL check is NOT_RUN.");
}

const isMain = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) printHelp();
  else {
    try {
      const report = await runCertification();
      console.log(JSON.stringify({ output: relative(REPOSITORY_ROOT, REPORT_PATH), status: report.status, runtime: report.runtime, checks: Object.fromEntries(Object.entries(report.checks).map(([id, check]) => [id, check.status])) }, null, 2));
      if (report.status === "FAIL") process.exitCode = 1;
    } catch (error) {
      console.error(`adoption-reality failed: ${message(error)}`);
      process.exitCode = 1;
    }
  }
}
