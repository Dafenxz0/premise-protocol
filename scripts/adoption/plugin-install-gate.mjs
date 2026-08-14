import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePlugin = join(root, "plugins", "premise-codex");
const artifactRoot = join(root, ".tmp", "adoption", "plugin-install-gate");
const installedPlugin = join(artifactRoot, "copied-plugin", "premise-codex");
const serverPath = join(installedPlugin, "mcp", "server.mjs");

async function filesUnder(directory, current = directory) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(directory, absolute));
    else files.push(relative(directory, absolute).split(sep).join("/"));
  }
  return files.sort();
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

function readFrame(stream, timeoutMs = 5_000) {
  let buffer = Buffer.alloc(0);
  let timer;
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const separator = buffer.indexOf(Buffer.from("\r\n\r\n"));
    if (separator < 0) return;
    const header = buffer.subarray(0, separator).toString("ascii");
    const line = header.split("\r\n").find((value) => /^content-length:/iu.test(value));
    const length = line === undefined ? NaN : Number.parseInt(line.split(":", 2)[1].trim(), 10);
    const start = separator + 4;
    if (!Number.isSafeInteger(length) || buffer.length < start + length) return;
    cleanup();
    resolvePromise(JSON.parse(buffer.subarray(start, start + length).toString("utf8")));
  };
  const onExit = (code, signal) => {
    cleanup();
    rejectPromise(new Error(`MCP process exited before response (code=${code}, signal=${signal ?? "none"})`));
  };
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  function cleanup() {
    stream.off("data", onData);
    stream.off("error", onError);
    stream.off("close", onClose);
    if (timer !== undefined) clearTimeout(timer);
  }
  function onError(error) {
    cleanup();
    rejectPromise(error);
  }
  function onClose() {
    cleanup();
    rejectPromise(new Error("MCP stdout closed before response"));
  }
  stream.on("data", onData);
  stream.once("error", onError);
  stream.once("close", onClose);
  timer = setTimeout(() => {
    cleanup();
    rejectPromise(new Error("Timed out waiting for MCP response"));
  }, timeoutMs);
  return promise;
}

async function request(child, id, method, params) {
  child.stdin.write(frame({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
  const response = await readFrame(child.stdout);
  assert.equal(response.id, id, `unexpected MCP response id for ${method}`);
  assert.equal(response.error, undefined, JSON.stringify(response));
  return response.result;
}

function notify(child, method, params) {
  child.stdin.write(frame({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }));
}

function parseToolText(result) {
  assert.ok(Array.isArray(result?.content));
  assert.equal(result.content[0]?.type, "text");
  return JSON.parse(result.content[0].text);
}

async function launchCopiedServer(environment) {
  const remoteMode = environment.PREMISE_MODE === "REMOTE" || environment.PREMISE_BASE_URL !== undefined;
  const childEnvironment = { ...process.env };
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete childEnvironment[key];
    else childEnvironment[key] = value;
  }
  const child = spawn(process.execPath, ["mcp/server.mjs"], {
    cwd: installedPlugin,
    env: childEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    const initialize = await request(child, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "premise-standalone-gate", version: "1.0.0" }
    });
    assert.equal(initialize.serverInfo.name, "premise");
    notify(child, "notifications/initialized");
    const listed = await request(child, 2, "tools/list");
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["check", "explain", "guard", "observe"]);
    const observed = parseToolText(await request(child, 3, "tools/call", {
      name: "observe",
      arguments: { memoryId: remoteMode ? "remote:1" : "local:premise" }
    }));
    const checked = parseToolText(await request(child, 4, "tools/call", {
      name: "check",
      arguments: { memoryId: remoteMode ? "remote:1" : "local:premise" }
    }));
    const guarded = parseToolText(await request(child, 5, "tools/call", {
      name: "guard",
      arguments: {
        memoryId: remoteMode ? "remote:1" : "local:premise",
        action: "publish release",
        risk: "HIGH"
      }
    }));
    assert.equal(observed.status, "FRESH");
    assert.equal(checked.result, "UNCHANGED");
    assert.equal(guarded.decision, "ALLOW");
    assert.equal(guarded.executesSideEffect, false);
    return { status: "PASS", tools: listed.tools.map((tool) => tool.name).sort(), observed, checked, guarded };
  } finally {
    child.stdin.end();
    if (!child.killed) child.kill();
    await new Promise((resolvePromise) => child.once("close", resolvePromise));
    if (stderr.trim().length > 0) throw new Error(`standalone MCP stderr: ${stderr.trim()}`);
  }
}

async function startRemoteFixture() {
  const timestamp = "2026-08-15T00:00:00.000Z";
  const record = {
    envelope: {
      specVersion: "premise/2",
      tenantId: "gate",
      memoryId: "remote:1",
      evidence: [{
        evidenceId: "evidence:remote:1",
        sourceUri: "http://fixture/source/1",
        observedAt: timestamp,
        version: { scheme: "etag", token: "v1" }
      }],
      confidence: { score: null, method: "standalone-gate", assessedAt: timestamp },
      conflicts: [],
      temporal: { asOf: timestamp },
      validity: { status: "FRESH", checkedAt: timestamp, policy: "VERSIONED" },
      dependsOn: [],
      signatures: []
    },
    content: { answer: "remote fixture" }
  };
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    const value = request.method === "GET" && path === "/v2/memories/remote:1"
      ? record
      : request.method === "POST" && path === "/v2/memories/remote:1/revalidate"
        ? { memoryId: "remote:1", result: "UNCHANGED", status: "FRESH", checkedAt: timestamp, version: { scheme: "etag", token: "v1" } }
        : { error: "not found" };
    response.writeHead(value.error === undefined ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/` };
}

await rm(artifactRoot, { recursive: true, force: true });
await mkdir(artifactRoot, { recursive: true });
await cp(sourcePlugin, installedPlugin, { recursive: true });

const manifest = JSON.parse(await readFile(join(installedPlugin, ".codex-plugin", "plugin.json"), "utf8"));
const mcpManifest = JSON.parse(await readFile(join(installedPlugin, ".mcp.json"), "utf8"));
assert.equal(manifest.mcpServers, "./.mcp.json");
assert.equal(mcpManifest.mcpServers.premise.command, "node");
assert.deepEqual(mcpManifest.mcpServers.premise.args, ["mcp/server.mjs"]);
assert.equal(await stat(serverPath).then(() => true), true);

const copiedFiles = await filesUnder(installedPlugin);
assert.equal(copiedFiles.some((file) => /(?:^|\/)packages(?:\/|$)|(?:^|\/)node_modules(?:\/|$)/u.test(file)), false);
const wiringText = await Promise.all([".mcp.json", "mcp/server.mjs"].map((file) => readFile(join(installedPlugin, ...file.split("/")), "utf8")));
assert.equal(wiringText.some((text) => /workspace:|packages\/mcp-server|packages\\mcp-server/u.test(text)), false);

const local = await launchCopiedServer({
  PREMISE_MODE: undefined,
  PREMISE_BASE_URL: undefined,
  PREMISE_TENANT: undefined,
  PREMISE_TOKEN: undefined
});
const remoteFixture = await startRemoteFixture();
let remote;
try {
  remote = await launchCopiedServer({ PREMISE_BASE_URL: remoteFixture.baseUrl, PREMISE_TENANT: "gate" });
} finally {
  await new Promise((resolvePromise, reject) => remoteFixture.server.close((error) => error ? reject(error) : resolvePromise()));
}

const report = {
  format: "premise-standalone-plugin-install-report/1",
  status: "PASS",
  copiedPlugin: "plugins/premise-codex",
  launchedFrom: "copied-plugin-only",
  local,
  remote,
  noMonorepoResolution: true,
  registryPublication: "NOT_RUN"
};
await writeFile(join(artifactRoot, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify(report, null, 2));
