import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePlugin = join(root, "plugins", "premise-codex");
const artifactRoot = join(root, ".tmp", "adoption", "plugin-install-gate");
const installedPlugin = join(artifactRoot, "copied-plugin", "premise-codex");
const serverPath = join(installedPlugin, "mcp", "server.mjs");
const packageRequire = createRequire(join(root, "packages", "mcp-server", "package.json"));
const { Client } = packageRequire("@modelcontextprotocol/client");
const { StdioClientTransport } = packageRequire("@modelcontextprotocol/client/stdio");

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

function parseToolText(result) {
  assert.ok(Array.isArray(result?.content));
  assert.equal(result.content[0]?.type, "text");
  return JSON.parse(result.content[0].text);
}

async function launchCopiedServer(environment) {
  const remoteMode = environment.PREMISE_MODE === "REMOTE" || environment.PREMISE_BASE_URL !== undefined;
  const childEnvironment = Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["mcp/server.mjs"],
    cwd: installedPlugin,
    env: childEnvironment,
    stderr: "pipe"
  });
  const client = new Client({ name: "premise-standalone-gate", version: "1.0.0" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["check", "explain", "guard", "observe"]);
    const memoryId = remoteMode ? "remote:1" : "selftest:premise";
    const observed = parseToolText(await client.callTool({ name: "observe", arguments: { memoryId } }));
    const checked = parseToolText(await client.callTool({ name: "check", arguments: { memoryId } }));
    const guarded = parseToolText(await client.callTool({
      name: "guard",
      arguments: { memoryId, action: "publish release", risk: "HIGH" }
    }));
    assert.equal(observed.status, "FRESH");
    assert.equal(checked.result, "UNCHANGED");
    assert.equal(guarded.decision, "ALLOW");
    assert.equal(guarded.executesSideEffect, false);
    return { status: "PASS", tools: listed.tools.map((tool) => tool.name).sort(), observed, checked, guarded };
  } finally {
    await client.close();
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

const selftest = await launchCopiedServer({
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
  selftest,
  remote,
  noMonorepoResolution: true,
  registryPublication: "NOT_RUN"
};
await writeFile(join(artifactRoot, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify(report, null, 2));
