const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const tenantId = process.env.PREMISE_TENANT_ID ?? "tenant:local";
const at = new Date().toISOString();
const memoryId = `memory:smoke:${Date.now()}`;
const sourceUri = `memory://${memoryId}`;

async function request(path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: { "content-type": "application/json", "x-premise-tenant": tenantId, ...(init.headers ?? {}) }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${body.error ?? "unknown error"}`);
  return body;
}

const readiness = await request("/readyz");
if (readiness.ok !== true) throw new Error("readiness probe did not report ok");
const capabilities = await request("/v2/capabilities");
if (capabilities.specVersion !== "premise/2") throw new Error("v2 capabilities are not advertised");

const envelope = {
  specVersion: "premise/2",
  tenantId,
  memoryId,
  evidence: [{ evidenceId: `evidence:${memoryId}`, sourceUri, observedAt: at, version: { scheme: "smoke", token: "v1" }, validator: { id: "smoke", operation: "read" } }],
  confidence: { score: null, method: "smoke", assessedAt: at },
  conflicts: [],
  temporal: { asOf: at },
  validity: { status: "FRESH", checkedAt: at, policy: "MANUAL" },
  dependsOn: [],
  signatures: []
};

const registerBody = JSON.stringify({ record: { envelope, content: "PREMiSE v2 smoke" } });
const idempotencyKey = `smoke:register:${memoryId}`;
const stored = await request("/v2/memories", { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: registerBody });
if (stored.memoryId !== memoryId) throw new Error("registered memory ID did not round-trip");
const replay = await request("/v2/memories", { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: registerBody });
if (replay.memoryId !== memoryId || replay.status !== "stored") throw new Error("idempotent register replay did not return the original response");
const conflictResponse = await fetch(new URL("/v2/memories", baseUrl), {
  method: "POST",
  headers: { "content-type": "application/json", "x-premise-tenant": tenantId, "idempotency-key": idempotencyKey },
  body: JSON.stringify({ record: { envelope, content: "PREMiSE v2 conflicting smoke request" } })
});
const conflictBody = await conflictResponse.json();
if (conflictResponse.status !== 409 || conflictBody.error !== "IDEMPOTENCY_CONFLICT") throw new Error("idempotency conflict was not rejected with 409");
const fetched = await request(`/v2/memories/${encodeURIComponent(memoryId)}`);
if (fetched.content !== "PREMiSE v2 smoke") throw new Error("stored content did not round-trip");
const query = await request("/v2/query", { method: "POST", body: JSON.stringify({ query: "PREMiSE smoke", maxTokens: 128 }) });
if (!Array.isArray(query.context?.selected) || query.context.selected.length < 1) throw new Error("query returned no context");
const changed = await request("/v2/source-changed", { method: "POST", body: JSON.stringify({ sourceUri, version: { scheme: "smoke", token: "v2" } }) });
if (!Array.isArray(changed.affected) || !changed.affected.includes(memoryId)) throw new Error("source change did not affect the smoke memory");

console.log(JSON.stringify({ ok: true, memoryId, specVersion: capabilities.specVersion }));
