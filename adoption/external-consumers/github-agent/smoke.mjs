import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PremiseClient } from "@premise/sdk";

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method === "GET" && path === "/health") {
    json(response, 200, { ok: true, specVersion: "premise/2", memories: 3, events: 4 });
    return;
  }
  if (request.method === "GET" && path === "/v2/capabilities") {
    json(response, 200, { specVersion: "premise/2", capabilities: ["TENANCY", "VERSIONED_SOURCE"] });
    return;
  }
  if (request.method === "POST" && path === "/v2/query") {
    json(response, 200, {
      hits: [{ id: "github:issue:42", text: "The release branch is protected.", score: 1 }],
      context: { selected: [{ id: "github:issue:42", text: "The release branch is protected." }] }
    });
    return;
  }
  json(response, 404, { error: "not found" });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");

try {
  const client = new PremiseClient({
    baseUrl: "http://127.0.0.1:" + address.port + "/",
    tenantId: "github:demo",
    maxRetries: 0
  });
  assert.equal((await client.health()).ok, true);
  assert.deepEqual((await client.capabilities()).capabilities, ["TENANCY", "VERSIONED_SOURCE"]);
  const answer = await client.query("Can the release branch be changed?", { limit: 1 });
  assert.equal(answer.hits[0].id, "github:issue:42");
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log("external github-like consumer passed");
