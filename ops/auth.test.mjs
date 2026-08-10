import assert from "node:assert/strict";
import { createBearerAuthorizer } from "./auth.mjs";

const principal = { tenantId: "tenant:test", subjectId: "subject:test" };
const request = (authorization) => ({ headers: authorization === undefined ? {} : { authorization } });
const token = "0123456789abcdef0123456789abcdef";

assert.equal(createBearerAuthorizer({ environment: "development", tenantId: "tenant:test" }), undefined);
assert.throws(() => createBearerAuthorizer({ environment: "production", tenantId: "tenant:test" }), /PREMISE_API_TOKEN/);
assert.throws(() => createBearerAuthorizer({ environment: "production", token: "too-short", tenantId: "tenant:test" }), /32 characters/);

const authorize = createBearerAuthorizer({ environment: "production", token, tenantId: "tenant:prod" });
assert.equal(authorize(request(), principal), false);
assert.equal(authorize(request("Basic abc"), principal), false);
assert.equal(authorize(request("Bearer wrong"), principal), false);
assert.deepEqual(authorize(request(`Bearer ${token}`), principal), { ...principal, tenantId: "tenant:prod" });

console.log("production bearer authorization tests passed");
