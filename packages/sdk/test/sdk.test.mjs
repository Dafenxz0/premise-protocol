import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import {
  PremiseClient,
  PremiseHttpError,
  PremisePaginationError,
  PremiseTimeoutError
} from "../dist/index.js";

const at = "2026-08-10T10:00:00Z";
const envelope = {
  specVersion: "premise/2",
  tenantId: "tenant:acme",
  memoryId: "memory:acme:1",
  evidence: [{ evidenceId: "evidence:1", sourceUri: "file:///notes.txt", observedAt: at }],
  confidence: { score: null, method: "test", assessedAt: at },
  conflicts: [],
  temporal: { asOf: at },
  validity: { status: "FRESH", checkedAt: at, policy: "MANUAL" },
  dependsOn: [],
  signatures: []
};
const record = { envelope, content: "PREMiSE context" };
const requests = [];
let retryAttempts = 0;

function readBody(request) {
  return new Promise((resolve, reject) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => resolve(text.length === 0 ? undefined : JSON.parse(text)));
    request.on("error", reject);
  });
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const body = await readBody(request);
  requests.push({
    method: request.method,
    path: url.pathname,
    headers: request.headers,
    body
  });

  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { ok: true, specVersion: "premise/2", memories: 1, events: 2 });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v2/capabilities") {
    json(response, 200, { specVersion: "premise/2", capabilities: ["TENANCY", "RETRIEVAL"] });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v2/memories") {
    json(response, 201, { memoryId: body.record.envelope.memoryId, status: "stored" });
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/v2/memories/")) {
    const memoryId = decodeURIComponent(url.pathname.slice("/v2/memories/".length));
    if (memoryId === "missing") {
      json(response, 404, { error: "memory not found" }, { "x-request-id": "request-missing" });
      return;
    }
    if (memoryId === "forbidden") {
      json(response, 403, { error: { code: "FORBIDDEN", message: "tenant denied", details: [{ field: "tenant" }] } });
      return;
    }
    json(response, 200, { ...record, envelope: { ...record.envelope, memoryId } });
    return;
  }
  if (request.method === "POST" && url.pathname.endsWith("/revalidate")) {
    json(response, 200, {
      memoryId: "memory:acme:1",
      result: "UNCHANGED",
      status: "FRESH",
      checkedAt: at,
      version: { scheme: "test", token: "v2" }
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v2/source-changed") {
    json(response, 202, { affected: ["memory:acme:1", "memory:acme:2"] });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v2/query") {
    if (body.query === "retry" && retryAttempts++ === 0) {
      json(response, 503, { error: { code: "TEMPORARY", message: "try again" } }, { "retry-after": "0" });
      return;
    }
    if (body.query === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (!response.destroyed) json(response, 200, { hits: [], context: { selected: [] } });
      return;
    }
    if (body.query === "pages") {
      const page = body.pageToken === "page-2" ? 2 : body.pageToken === "page-3" ? 3 : 1;
      json(response, 200, {
        hits: [{ id: "memory:page:" + page, text: "page " + page, score: 1 }],
        context: { selected: [] },
        ...(page === 3 ? {} : { nextPageToken: "page-" + (page + 1) })
      });
      return;
    }
    json(response, 200, {
      hits: [{ id: "memory:acme:1", text: "PREMiSE context", score: 1 }],
      context: { selected: [{ id: "memory:acme:1", text: "PREMiSE context" }] }
    });
    return;
  }
  json(response, 404, { error: "route not found" });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = "http://127.0.0.1:" + address.port + "/";
const logs = [];
const client = new PremiseClient({
  baseUrl,
  tenantId: "tenant:acme",
  subjectId: "subject:one",
  token: "secret-token",
  timeoutMs: 1_000,
  maxRetries: 1,
  retry: { baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
  sleep: async () => undefined,
  random: () => 0,
  logger: (event) => logs.push(event)
});

try {
  const health = await client.health();
  assert.equal(health.specVersion, "premise/2");
  const healthRequest = requests.find(({ path }) => path === "/health");
  assert.equal(healthRequest.headers["x-premise-tenant"], "tenant:acme");
  assert.equal(healthRequest.headers["x-premise-subject"], "subject:one");
  assert.equal(healthRequest.headers.authorization, "Bearer secret-token");
  assert.ok(healthRequest.headers["x-request-id"]);

  const capabilities = await client.capabilities();
  assert.deepEqual(capabilities.capabilities, ["TENANCY", "RETRIEVAL"]);

  const stored = await client.registerMemory(record, { idempotencyKey: "memory-write:1" });
  assert.deepEqual(stored, { memoryId: "memory:acme:1", status: "stored" });
  const registerRequest = requests.find(({ path, body }) => path === "/v2/memories" && body?.derived === undefined);
  assert.equal(registerRequest.headers["x-premise-tenant"], "tenant:acme");
  assert.equal(registerRequest.headers["idempotency-key"], "memory-write:1");

  await client.deriveMemory(record, { idempotencyKey: "memory-derive:1" });
  const derivedRequest = requests.find(({ path, body }) => path === "/v2/memories" && body?.derived === true);
  assert.equal(derivedRequest.headers["idempotency-key"], "memory-derive:1");

  const fetched = await client.getMemory("memory:with:colon", { maxRetries: 0 });
  assert.equal(fetched.envelope.memoryId, "memory:with:colon");
  assert.ok(requests.some(({ path }) => path === "/v2/memories/memory%3Awith%3Acolon"));

  const query = await client.query({ query: "current", options: { limit: 1 }, maxTokens: 32 });
  assert.equal(query.hits[0].id, "memory:acme:1");
  assert.equal(query.context.selected[0].id, "memory:acme:1");

  const retried = await client.query({ query: "retry" }, { maxRetries: 1 });
  assert.equal(retried.hits.length, 1);
  const retryRequests = requests.filter(({ body }) => body?.query === "retry");
  assert.equal(retryRequests.length, 2);
  assert.equal(retryRequests[0].headers["idempotency-key"], retryRequests[1].headers["idempotency-key"]);
  assert.ok(logs.some(({ type, code }) => type === "retry" && code === "TEMPORARY"));

  const allPages = await client.queryAll({ query: "pages", pageSize: 1 }, { maxPages: 3 });
  assert.deepEqual(allPages.map(({ id }) => id), ["memory:page:1", "memory:page:2", "memory:page:3"]);
  const pageRequests = requests.filter(({ body }) => body?.query === "pages");
  assert.deepEqual(pageRequests.map(({ body: pageBody }) => pageBody.pageToken), [undefined, "page-2", "page-3"]);
  assert.equal(pageRequests[0].body.options.limit, 1);

  const validation = await client.revalidate("memory:acme:1", { idempotencyKey: "revalidate:1" });
  assert.equal(validation.result, "UNCHANGED");
  const changed = await client.sourceChanged("file:///notes.txt", { scheme: "test", token: "v2" }, { idempotencyKey: "source:2" });
  assert.deepEqual(changed.affected, ["memory:acme:1", "memory:acme:2"]);

  await assert.rejects(
    () => client.getMemory("missing", { maxRetries: 0 }),
    (error) => error instanceof PremiseHttpError
      && error.status === 404
      && error.code === "HTTP_404"
      && error.requestId === "request-missing"
  );
  await assert.rejects(
    () => client.getMemory("forbidden", { maxRetries: 0 }),
    (error) => error instanceof PremiseHttpError
      && error.status === 403
      && error.code === "FORBIDDEN"
      && error.details?.length === 1
  );

  await assert.rejects(
    () => client.query({ query: "slow" }, { timeoutMs: 5, maxRetries: 0 }),
    (error) => error instanceof PremiseTimeoutError && error.timeoutMs === 5
  );

  const cyclicClient = new PremiseClient({
    baseUrl,
    tenantId: "tenant:acme",
    maxRetries: 0,
    sleep: async () => undefined,
    logger: () => undefined
  });
  const originalQuery = cyclicClient.query.bind(cyclicClient);
  cyclicClient.query = async (input, options) => {
    const response = await originalQuery(input, options);
    return { ...response, nextPageToken: "same-token" };
  };
  await assert.rejects(
    () => cyclicClient.queryAll({ query: "current" }, { maxPages: 2 }),
    (error) => error instanceof PremisePaginationError
  );

  assert.throws(
    () => client.registerMemory({ ...record, envelope: { ...record.envelope, tenantId: "tenant:other" } }),
    /tenantId must match/
  );

  const serializedLogs = JSON.stringify(logs);
  assert.ok(serializedLogs.includes("[REDACTED]"));
  assert.ok(!serializedLogs.includes("secret-token"));
  assert.ok(!serializedLogs.includes("memory-write:1"));

  const openapi = JSON.parse(await readFile(new URL("../../../spec/ga-api/openapi.json", import.meta.url), "utf8"));
  assert.equal(openapi.openapi, "3.1.0");
  assert.ok(openapi.paths["/v2/query"]);
  for (const file of [
    "error.schema.json",
    "memory-record.schema.json",
    "query-request.schema.json",
    "query-response.schema.json",
    "revalidation-report.schema.json",
    "source-changed-response.schema.json"
  ]) {
    const schema = JSON.parse(await readFile(new URL("../../../spec/ga-api/schemas/" + file, import.meta.url), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  }
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log("premise sdk tests passed");
