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
const server = new PremiseServer({ runtime });
await server.listen({ host: "127.0.0.1", port: 0 });
const address = server.server.address();
assert.ok(address && typeof address === "object" && address.port > 0);
const base = `http://127.0.0.1:${address.port}`;

const health = await fetch(`${base}/health`);
assert.equal(health.status, 200);
assert.equal((await health.json()).specVersion, "premise/2");

const stored = await fetch(`${base}/v2/memories`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ record: { envelope, content: "PREMiSE v2 exact context" } }) });
assert.equal(stored.status, 201);

const query = await fetch(`${base}/v2/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "PREMiSE", maxTokens: 100 }) });
assert.equal(query.status, 200);
assert.equal((await query.json()).context.selected.length, 1);

const fetched = await fetch(`${base}/v2/memories/${encodeURIComponent(envelope.memoryId)}`);
assert.equal(fetched.status, 200);
assert.equal((await fetched.json()).content, "PREMiSE v2 exact context");
await server.close();

console.log("premise-server v2 HTTP tests passed");
