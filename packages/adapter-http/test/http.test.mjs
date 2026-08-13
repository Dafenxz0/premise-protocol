import test from "node:test";
import assert from "node:assert/strict";
import { HttpAdapter } from "../dist/index.js";

function response(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("HTTP adapter observes ETags and uses conditional revalidation", async () => {
  const calls = [];
  const adapter = new HttpAdapter({
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) return response(200, { id: 1 }, { etag: "\"v1\"" });
      return response(304, undefined, { etag: "\"v1\"" });
    },
    now: () => Date.parse("2026-08-14T00:00:00Z")
  });
  const observed = await adapter.observe({ tenantId: "tenant:test", resource: "https://example.test/item/1" });
  assert.equal(observed.version.token, '"v1"');
  const result = await adapter.revalidate({ tenantId: "tenant:test", record: observed.value, evidence: observed.evidence[0] });
  assert.equal(result.result, "UNCHANGED");
  assert.equal(calls[1].init.headers["If-None-Match"], '"v1"');
});

test("HTTP adapter maps 412 to a safe version mismatch and supports custom versions", async () => {
  const adapter = new HttpAdapter({
    fetch: async (_url, init) => init.method === "PUT" ? response(412, { error: "changed" }, { etag: "v2" }) : response(200, { version: 7 }),
    versionExtractor: (_response, body) => ({ scheme: "body.version", token: String(body.version) }),
    allowCustomIfMatch: true
  });
  const observed = await adapter.observe({ tenantId: "tenant:test", resource: "https://example.test/item/1" });
  assert.equal(observed.version.token, "7");
  const result = await adapter.conditionalAction({ tenantId: "tenant:test", resource: "https://example.test/item/1", expectedVersion: { scheme: "body.version", token: "7" }, action: { method: "PUT", body: { value: 2 } } });
  assert.deepEqual(result, { accepted: false, reason: "VERSION_MISMATCH", status: 412, observedVersion: { scheme: "http.etag", token: "v2" } });
});

test("HTTP adapter fails closed when no version is available", async () => {
  const adapter = new HttpAdapter({ fetch: async () => response(200, { id: 1 }) });
  await assert.rejects(() => adapter.observe({ tenantId: "tenant:test", resource: "https://example.test/item/1" }), /version/);
});

test("weak ETags are readable but never authorize an If-Match action", async () => {
  const adapter = new HttpAdapter({ fetch: async () => response(200, { id: 1 }, { etag: 'W/"v1"' }) });
  const observed = await adapter.observe({ tenantId: "tenant:test", resource: "https://example.test/item/1" });
  assert.deepEqual(await adapter.conditionalAction({ tenantId: "tenant:test", resource: "https://example.test/item/1", expectedVersion: observed.version, action: { method: "PUT" } }), { accepted: false, reason: "REJECT", status: 412 });
});

test("tenant binding cannot be overwritten by adapter headers", async () => {
  let seen;
  const adapter = new HttpAdapter({ tenantHeader: "x-tenant", headers: { "x-tenant": "wrong" }, fetch: async (_url, init) => { seen = init.headers; return response(200, { id: 1 }, { etag: "v1" }); } });
  await adapter.observe({ tenantId: "tenant:correct", resource: "https://example.test/item/1" });
  assert.equal(seen["x-tenant"], "tenant:correct");
});
