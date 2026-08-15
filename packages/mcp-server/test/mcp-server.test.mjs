import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";
import { createConfiguredClient } from "../dist/index.js";

const at = "2026-08-14T00:00:00Z";
const record = {
  envelope: {
    specVersion: "premise/2",
    tenantId: "mcp:test",
    memoryId: "memory:mcp:1",
    evidence: [{
      evidenceId: "evidence:mcp:1",
      sourceUri: "http://127.0.0.1/source/1",
      observedAt: at,
      version: { scheme: "etag", token: "v1" }
    }],
    confidence: { score: null, method: "mcp-test", assessedAt: at },
    conflicts: [],
    temporal: { asOf: at },
    validity: { status: "FRESH", checkedAt: at, policy: "VERSIONED" },
    dependsOn: [],
    signatures: []
  },
  content: { answer: "fresh" }
};

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const httpServer = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  if (request.method === "GET" && path === "/v2/memories/memory:mcp:1") {
    json(response, 200, record);
    return;
  }
  if (request.method === "POST" && path === "/v2/memories/memory:mcp:1/revalidate") {
    json(response, 200, {
      memoryId: "memory:mcp:1",
      result: "UNCHANGED",
      status: "FRESH",
      checkedAt: at,
      version: { scheme: "etag", token: "v1" }
    });
    return;
  }
  json(response, 404, { error: "not found" });
});

await new Promise((resolvePromise) => httpServer.listen(0, "127.0.0.1", resolvePromise));
const address = httpServer.address();
assert.ok(address && typeof address === "object");
const serverPath = resolve("dist/index.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: {
    ...process.env,
    PREMISE_BASE_URL: "http://127.0.0.1:" + address.port + "/",
    PREMISE_TENANT: "mcp:test",
    PREMISE_TOKEN: "test-token"
  }
});
const client = new Client({ name: "premise-mcp-test", version: "1.0.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["check", "explain", "guard", "observe"]);

  const observed = await client.callTool({ name: "observe", arguments: { memoryId: "memory:mcp:1" } });
  assert.equal(observed.isError, undefined);
  assert.match(observed.content[0].text, /"status": "FRESH"/u);

  const checked = await client.callTool({ name: "check", arguments: { memoryId: "memory:mcp:1" } });
  assert.match(checked.content[0].text, /"result": "UNCHANGED"/u);

  const guarded = await client.callTool({
    name: "guard",
    arguments: { memoryId: "memory:mcp:1", action: "publish release", risk: "HIGH" }
  });
  assert.match(guarded.content[0].text, /"decision": "ALLOW"/u);
  assert.match(guarded.content[0].text, /"executesSideEffect": false/u);
} finally {
  await client.close();
  await new Promise((resolvePromise, reject) => httpServer.close((error) => error ? reject(error) : resolvePromise()));
}

const selftestEnv = { ...process.env };
delete selftestEnv.PREMISE_MODE;
delete selftestEnv.PREMISE_BASE_URL;
delete selftestEnv.PREMISE_TENANT;
delete selftestEnv.PREMISE_TOKEN;
assert.doesNotThrow(() => createConfiguredClient(selftestEnv));
assert.throws(() => createConfiguredClient({ PREMISE_MODE: "REMOTE" }), /PREMISE_BASE_URL is required/u);
assert.throws(() => createConfiguredClient({ PREMISE_MODE: "LOCAL" }), /PREMISE_MODE must be SELFTEST or REMOTE/u);

const selftestTransport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: selftestEnv
});
const selftestClient = new Client({ name: "premise-mcp-selftest", version: "1.0.0" });
try {
  await selftestClient.connect(selftestTransport);
  const listed = await selftestClient.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["check", "explain", "guard", "observe"]);
  const observed = await selftestClient.callTool({ name: "observe", arguments: { memoryId: "selftest:premise" } });
  assert.match(observed.content[0].text, /"tenantId": "selftest"/u);
  assert.match(observed.content[0].text, /selftest:\/\/premise/u);
  const checked = await selftestClient.callTool({ name: "check", arguments: { memoryId: "selftest:premise" } });
  assert.match(checked.content[0].text, /"status": "FRESH"/u);
  const guarded = await selftestClient.callTool({
    name: "guard",
    arguments: { memoryId: "selftest:premise", action: "publish release", risk: "HIGH" }
  });
  assert.match(guarded.content[0].text, /"decision": "ALLOW"/u);
  assert.match(guarded.content[0].text, /"executesSideEffect": false/u);
} finally {
  await selftestClient.close();
}

console.log("mcp server tests passed");
