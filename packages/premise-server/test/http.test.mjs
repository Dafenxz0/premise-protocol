import assert from "node:assert/strict";
import { createServer } from "../dist/index.js";

const at = "2026-08-10T08:00:00Z";
const baseEnvelope = (memoryId, dependsOn = []) => ({
  specVersion: "premise/0.1",
  memoryId,
  provenance: [{
    sourceUri: `file://${memoryId}`,
    observedAt: at,
    version: { scheme: "test", token: "v1" },
    validator: { id: "test", operation: "read" }
  }],
  validity: { status: "FRESH", checkedAt: at, policy: dependsOn.length === 0 ? "VERSIONED" : "MANUAL" },
  dependsOn
});

const validator = {
  id: "test",
  validate: (source) => ({
    memoryId: source.memoryId,
    result: "UNCHANGED",
    status: "FRESH",
    checkedAt: at,
    version: source.version
  })
};

const server = createServer({
  maxBodyBytes: 512,
  validators: [validator],
  authorize: ({ request }) => {
    const token = request.headers.authorization;
    return token === "Bearer tenant-a" || token === "Bearer tenant-b" ? { tenantId: token.slice("Bearer ".length) } : null;
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.equal(typeof address, "object");
const endpoint = `http://127.0.0.1:${address.port}`;

async function call(path, { body, headers = {}, ...init } = {}) {
  const requestInit = {
    ...init,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }
  };
  if (body !== undefined) {
    requestInit.method = "POST";
    requestInit.body = JSON.stringify(body);
  }
  const response = await fetch(`${endpoint}${path}`, requestInit);
  return { response, json: await response.json() };
}

try {
  const health = await call("/v1/health", { headers: { "x-request-id": "health-1" } });
  assert.equal(health.response.status, 200);
  assert.equal(health.json.status, "ok");
  assert.equal(health.json.requestId, "health-1");

  const registered = await call("/register", {
    body: { envelope: baseEnvelope("memory-a"), content: { answer: 42 } },
    headers: { authorization: "Bearer tenant-a", "x-request-id": "register-1" }
  });
  assert.equal(registered.response.status, 201);
  assert.equal(registered.json.memoryId, "memory-a");
  assert.equal(registered.json.requestId, "register-1");

  const derived = await call("/v1/derive", {
    body: { envelope: baseEnvelope("memory-b", ["memory-a"]), content: "derived" },
    headers: { authorization: "Bearer tenant-a" }
  });
  assert.equal(derived.response.status, 201);

  const signal = await call("/v1/signal", {
    body: {
      specVersion: "premise/0.1",
      eventId: "source-change-1",
      type: "SourceChanged",
      occurredAt: at,
      payload: { sourceUri: "file://memory-a", version: { scheme: "test", token: "v2" } }
    },
    headers: { authorization: "Bearer tenant-a" }
  });
  assert.equal(signal.response.status, 200);
  assert.deepEqual(signal.json.affected, ["memory-a", "memory-b"]);

  const checked = await call("/check", {
    body: { memoryIds: ["memory-a", "memory-b"] },
    headers: { authorization: "Bearer tenant-a" }
  });
  assert.deepEqual(checked.json.items.map(({ memoryId, decision }) => [memoryId, decision]), [
    ["memory-a", "REVALIDATE"],
    ["memory-b", "REVALIDATE"]
  ]);

  const validated = await call("/v1/validate", {
    body: {
      memoryIds: ["memory-a"],
      results: {
        "memory-a": {
          memoryId: "memory-a",
          result: "UNCHANGED",
          status: "FRESH",
          checkedAt: at,
          version: { scheme: "test", token: "v2" }
        }
      }
    },
    headers: { authorization: "Bearer tenant-a" }
  });
  assert.equal(validated.response.status, 200);
  assert.equal(validated.json.items[0].status, "FRESH");

  const retrieved = await call("/v1/retrieve", {
    body: { memoryIds: ["memory-a", "memory-b"] },
    headers: { authorization: "Bearer tenant-a" }
  });
  assert.equal(retrieved.response.status, 200);
  assert.deepEqual(retrieved.json.items.map(({ memoryId }) => memoryId), ["memory-a", "memory-b"]);
  assert.deepEqual(retrieved.json.items[0].content, { answer: 42 });

  const isolated = await call("/v1/retrieve", {
    body: { memoryIds: ["memory-a"] },
    headers: { authorization: "Bearer tenant-b" }
  });
  assert.equal(isolated.response.status, 404);
  assert.equal(isolated.json.error.code, "NOT_FOUND");

  const invalid = await call("/v1/register", {
    body: { envelope: { specVersion: "wrong", memoryId: "broken" } },
    headers: { authorization: "Bearer tenant-a" }
  });
  assert.equal(invalid.response.status, 422);
  assert.equal(invalid.json.error.code, "VALIDATION_ERROR");
  assert.ok(Array.isArray(invalid.json.error.details));

  const tooLarge = await call("/v1/register", {
    body: { envelope: baseEnvelope("too-large"), content: "x".repeat(2_000) },
    headers: { authorization: "Bearer tenant-a" }
  });
  assert.equal(tooLarge.response.status, 413);
  assert.equal(tooLarge.json.error.code, "BODY_TOO_LARGE");

  const unauthorized = await call("/v1/check", { body: { memoryIds: ["memory-a"] } });
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.json.error.code, "UNAUTHORIZED");
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log("premise-server HTTP tests passed");
