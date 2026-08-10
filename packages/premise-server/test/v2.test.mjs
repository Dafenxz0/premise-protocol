import assert from "node:assert/strict";
import { PremiseRuntime } from "@premise/runtime-core";
import { PremiseServer } from "../dist/v2.js";

const at = "2026-08-10T10:00:00Z";
const envelope = {
  specVersion: "premise/2",
  tenantId: "tenant:http",
  memoryId: "memory:http:v2",
  evidence: [{ evidenceId: "e:http", sourceUri: "file:///http", observedAt: at }],
  confidence: { score: null, method: "test", assessedAt: at },
  conflicts: [],
  temporal: { asOf: at },
  validity: { status: "FRESH", checkedAt: at, policy: "MANUAL" },
  dependsOn: [],
  signatures: []
};

const runtime = new PremiseRuntime({ tenantId: "tenant:http", now: () => at });
const metrics = [];
const server = new PremiseServer({ runtime, onMetric: (metric) => metrics.push(metric) });
await server.listen({ host: "127.0.0.1", port: 0 });
const address = server.server.address();
assert.ok(address && typeof address === "object" && address.port > 0);
const base = `http://127.0.0.1:${address.port}`;

const health = await fetch(`${base}/health`);
assert.equal(health.status, 200);
assert.equal((await health.json()).specVersion, "premise/2");
assert.ok(/^[\x21-\x7e-]{10,128}$/u.test(health.headers.get("x-request-id") ?? ""));

const registerBody = JSON.stringify({ record: { envelope, content: "PREMiSE v2 exact context" } });
const stored = await fetch(`${base}/v2/memories`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "http-register-1" }, body: registerBody });
assert.equal(stored.status, 201);
const storedReplay = await fetch(`${base}/v2/memories`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "http-register-1" }, body: registerBody });
assert.equal(storedReplay.status, 201, "replaying a successful mutation with the same Idempotency-Key must be safe");
const storedDefaultReplay = await fetch(`${base}/v2/memories`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "http-register-1" }, body: JSON.stringify({ record: { envelope, content: "PREMiSE v2 exact context" }, derived: false }) });
assert.equal(storedDefaultReplay.status, 201, "omitting the default derived=false must not change the idempotency digest");
const storedConflict = await fetch(`${base}/v2/memories`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "http-register-1" }, body: JSON.stringify({ record: { envelope, content: "different request" } }) });
assert.equal(storedConflict.status, 409, "reusing an Idempotency-Key with a different payload must be rejected");

const invalidEnvelope = await fetch(`${base}/v2/memories`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "invalid-envelope-1" }, body: JSON.stringify({ record: { envelope: { specVersion: "premise/2" }, content: "broken" } }) });
assert.equal(invalidEnvelope.status, 422);
assert.equal((await invalidEnvelope.json()).error, "VALIDATION_ERROR");

const invalidKey = await fetch(`${base}/v2/memories`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "bad key" }, body: registerBody });
assert.equal(invalidKey.status, 400);
assert.equal((await invalidKey.json()).error, "INVALID_IDEMPOTENCY_KEY");

const query = await fetch(`${base}/v2/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "PREMiSE", maxTokens: 100 }) });
assert.equal(query.status, 200);
assert.equal((await query.json()).context.selected.length, 1);
const oversizedQuery = await fetch(`${base}/v2/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "PREMiSE", options: { limit: 1001 } }) });
assert.equal(oversizedQuery.status, 400);
assert.equal((await oversizedQuery.json()).error, "INVALID_QUERY_LIMIT");

const missingQuery = await fetch(`${base}/v2/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
assert.equal(missingQuery.status, 400);
assert.equal((await missingQuery.json()).error, "INVALID_REQUEST");

const unsupportedPage = await fetch(`${base}/v2/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "PREMiSE", pageToken: "page-2" }) });
assert.equal(unsupportedPage.status, 501);
assert.equal((await unsupportedPage.json()).error, "PAGINATION_UNSUPPORTED");

const invalidVersion = await fetch(`${base}/v2/source-changed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceUri: "file:///http", version: { scheme: "file.mtime" } }) });
assert.equal(invalidVersion.status, 400);
assert.equal((await invalidVersion.json()).error, "INVALID_REQUEST");

const fetched = await fetch(`${base}/v2/memories/${encodeURIComponent(envelope.memoryId)}`);
assert.equal(fetched.status, 200);
assert.equal((await fetched.json()).content, "PREMiSE v2 exact context");

const sourceChangedBody = JSON.stringify({ sourceUri: "file:///http", version: { scheme: "file.mtime", token: "b2" } });
const sourceChanged = await fetch(`${base}/v2/source-changed`, { method: "POST", headers: { "content-type": "application/json" }, body: sourceChangedBody });
assert.equal(sourceChanged.status, 202);
const sourceChangedJson = await sourceChanged.json();
assert.deepEqual(sourceChangedJson.affected, [envelope.memoryId]);
const sourceChangedReplay = await fetch(`${base}/v2/source-changed`, { method: "POST", headers: { "content-type": "application/json" }, body: sourceChangedBody });
assert.equal(sourceChangedReplay.status, 202);
assert.deepEqual((await sourceChangedReplay.json()).affected, sourceChangedJson.affected);
assert.equal(runtime.history().filter((event) => event.type === "SourceChanged").length, 1);
assert.equal(runtime.history().filter((event) => event.type === "MemoryStaled").length, 1);
await server.close();
assert.ok(metrics.length >= 4);
assert.ok(metrics.every((metric) => metric.durationMs >= 0 && metric.requestId.length > 0));

const capturedSearchOptions = [];
const scopedRuntime = new PremiseRuntime({ tenantId: "tenant:filter", now: () => at });
const scopedServer = new PremiseServer({
  runtime: scopedRuntime,
  index: {
    async upsert() {},
    async search(_query, options) { capturedSearchOptions.push(options); return []; }
  }
});
await scopedServer.listen({ host: "127.0.0.1", port: 0 });
const scopedAddress = scopedServer.server.address();
assert.ok(scopedAddress && typeof scopedAddress === "object");
const scopedQuery = await fetch(`http://127.0.0.1:${scopedAddress.port}/v2/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "PREMiSE", options: { filters: { topic: "release" } } }) });
assert.equal(scopedQuery.status, 200);
assert.deepEqual(capturedSearchOptions[0].filter, { topic: "release", tenantId: "tenant:filter" });
assert.equal(capturedSearchOptions[0].filters, undefined);
await scopedServer.close();

const deniedRuntime = new PremiseRuntime({ tenantId: "tenant:denied", now: () => at });
const denied = new PremiseServer({ runtime: deniedRuntime, authorize: () => false });
await denied.listen({ host: "127.0.0.1", port: 0 });
const deniedAddress = denied.server.address();
assert.ok(deniedAddress && typeof deniedAddress === "object");
const deniedResponse = await fetch(`http://127.0.0.1:${deniedAddress.port}/health`);
assert.equal(deniedResponse.status, 401);
assert.equal((await deniedResponse.json()).error, "UNAUTHORIZED");
await denied.close();

console.log("premise-server v2 HTTP tests passed");
