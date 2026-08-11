import assert from "node:assert/strict";
import {
  assertRlsSafeDatabaseRole,
  authorizeOperationalRequest,
  createBearerAuthorizer,
  isLoopbackAddress
} from "./auth.mjs";

const principal = { tenantId: "tenant:test", subjectId: "subject:test" };
const request = (authorization, remoteAddress = undefined) => ({
  headers: authorization === undefined ? {} : { authorization },
  ...(remoteAddress === undefined ? {} : { socket: { remoteAddress } })
});
const token = "0123456789abcdef0123456789abcdef";

assert.equal(createBearerAuthorizer({ environment: "development", tenantId: "tenant:test" }), undefined);
assert.throws(() => createBearerAuthorizer({ environment: "production", tenantId: "tenant:test" }), /PREMISE_API_TOKEN/);
assert.throws(() => createBearerAuthorizer({ environment: "production", token: "too-short", tenantId: "tenant:test" }), /32 characters/);
assert.throws(() => createBearerAuthorizer({ environment: "production", token: "too-short", tokenName: "PREMISE_METRICS_TOKEN", tenantId: "tenant:test" }), /PREMISE_METRICS_TOKEN/);

const authorize = createBearerAuthorizer({ environment: "production", token, tenantId: "tenant:prod" });
assert.equal(authorize(request(), principal), false);
assert.equal(authorize(request("Basic abc"), principal), false);
assert.equal(authorize(request("Bearer wrong"), principal), false);
assert.deepEqual(authorize(request(`Bearer ${token}`), principal), { ...principal, tenantId: "tenant:prod" });

assert.equal(isLoopbackAddress("127.0.0.1"), true);
assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
assert.equal(isLoopbackAddress("10.0.0.4"), false);
assert.equal(authorizeOperationalRequest(authorize, request(), principal), false);
assert.equal(authorizeOperationalRequest(authorize, request(), principal, { allowLoopback: true }), false, "loopback bypass must inspect the actual socket address");
assert.equal(authorizeOperationalRequest(authorize, request(undefined, "127.0.0.1"), principal, { allowLoopback: true }), true);
assert.equal(authorizeOperationalRequest(authorize, request(), principal, { allowLoopback: true }), false);
assert.equal(authorizeOperationalRequest(undefined, request(), principal), true, "development without a token remains open for local smoke tests");

assert.doesNotThrow(() => assertRlsSafeDatabaseRole({ rows: [{ rolsuper: false, rolbypassrls: false }] }));
assert.throws(() => assertRlsSafeDatabaseRole({ rows: [{ rolsuper: true, rolbypassrls: false }] }), /NOSUPERUSER/);
assert.throws(() => assertRlsSafeDatabaseRole({ rows: [{ rolsuper: false, rolbypassrls: true }] }), /NOBYPASSRLS/);
assert.throws(() => assertRlsSafeDatabaseRole({ rows: [] }), /NOBYPASSRLS/);

console.log("production bearer authorization tests passed");
