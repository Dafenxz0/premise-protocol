import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PremiseClient } from "@premise/sdk";

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method === "POST" && path === "/v2/memories/memory%3Arest%3A1/revalidate") {
    json(response, 200, {
      memoryId: "memory:rest:1",
      result: "UNCHANGED",
      status: "FRESH",
      checkedAt: "2026-08-14T00:00:00Z",
      version: { scheme: "etag", token: "rest-v1" }
    });
    return;
  }
  if (request.method === "POST" && path === "/v2/source-changed") {
    json(response, 202, { affected: ["memory:rest:1"] });
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
    tenantId: "rest:demo",
    maxRetries: 0
  });
  const check = await client.revalidate("memory:rest:1", { idempotencyKey: "rest-check-1" });
  assert.equal(check.status, "FRESH");
  const changed = await client.sourceChanged(
    "https://api.example.test/orders/42",
    { scheme: "etag", token: "rest-v2" },
    { idempotencyKey: "rest-signal-1" }
  );
  assert.deepEqual(changed.affected, ["memory:rest:1"]);
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log("external REST consumer passed");
