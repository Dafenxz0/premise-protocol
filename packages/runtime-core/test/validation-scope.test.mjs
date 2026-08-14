import assert from "node:assert/strict";
import test from "node:test";
import {
  FencedSingleFlightCoordinator,
  RuntimeReceiptCache,
  canonicalPremiseValidationScope,
  canonicalPremiseValidationSupersessionScope,
  premiseReceiptSharingKey,
  premiseValidationScopeKey,
  premiseValidationSupersessionKey
} from "../dist/index.js";

const at = "2026-08-14T10:00:00.000Z";
const scope = (overrides = {}) => ({
  tenantId: "tenant:acme",
  resourceId: "resource:repo",
  incarnationId: "incarnation:1",
  versionScheme: "github.commit",
  versionToken: "commit:a",
  validatorId: "validator:github",
  authorizationContextDigest: "auth:reader",
  policyDigest: "policy:read",
  queryDigest: "query:head",
  scopes: ["read:head", "read:status"],
  changeSetDigest: null,
  causalFrontier: ["event:1", "event:2"],
  ...overrides
});

test("one canonical identity binds every complete sharing dimension", () => {
  const base = scope();
  assert.equal(premiseReceiptSharingKey(base), premiseValidationScopeKey(base));
  assert.equal(
    canonicalPremiseValidationScope({ ...base, scopes: [...base.scopes].reverse(), causalFrontier: [...base.causalFrontier].reverse() }),
    canonicalPremiseValidationScope(base)
  );

  const mismatches = [
    ["tenant", { tenantId: "tenant:other" }],
    ["resource", { resourceId: "resource:other" }],
    ["incarnation", { incarnationId: "incarnation:2" }],
    ["version scheme", { versionScheme: "git.object" }],
    ["version", { versionToken: "commit:b" }],
    ["validator", { validatorId: "validator:other" }],
    ["authorization", { authorizationContextDigest: "auth:writer" }],
    ["policy", { policyDigest: "policy:strict" }],
    ["query", { queryDigest: "query:status" }],
    ["scope", { scopes: ["read:head"] }],
    ["change-set", { changeSetDigest: "changes:1" }],
    ["frontier", { causalFrontier: ["event:1", "event:3"] }]
  ];
  for (const [name, override] of mismatches) assert.notEqual(premiseValidationScopeKey(base), premiseValidationScopeKey({ ...base, ...override }), `${name} must not share`);
});

test("incarnation identity rejects ABA reuse of a version token", () => {
  const oldScope = scope({ incarnationId: "incarnation:old" });
  const newScope = scope({ incarnationId: "incarnation:new" });
  assert.equal(oldScope.versionToken, newScope.versionToken);
  assert.notEqual(premiseValidationScopeKey(oldScope), premiseValidationScopeKey(newScope));

  const cache = new RuntimeReceiptCache({ maxEntries: 4 });
  cache.put({ scope: oldScope, state: "FRESH", valid: true, observedAt: at, expiresAt: "2026-08-14T10:01:00.000Z", value: "old" });
  assert.equal(cache.get(newScope, at).status, "MISS");
});

test("supersession identity excludes validation-only dimensions", () => {
  const base = scope();
  const queryAuthPolicy = scope({
    validatorId: "validator:other",
    authorizationContextDigest: "auth:writer",
    policyDigest: "policy:strict",
    queryDigest: "query:status",
    scopes: ["write:merge"],
    changeSetDigest: "changes:1",
    causalFrontier: ["event:99"]
  });

  assert.equal(canonicalPremiseValidationSupersessionScope(base), canonicalPremiseValidationSupersessionScope(queryAuthPolicy));
  assert.equal(premiseValidationSupersessionKey(base), premiseValidationSupersessionKey(queryAuthPolicy));
  assert.notEqual(
    premiseValidationSupersessionKey(base),
    premiseValidationSupersessionKey(scope({ versionToken: "commit:b" }))
  );
  assert.notEqual(
    premiseValidationSupersessionKey(base),
    premiseValidationSupersessionKey(scope({ incarnationId: "incarnation:2" }))
  );
});

test("fenced flights coalesce only complete identical scopes", async () => {
  let calls = 0;
  const coordinator = new FencedSingleFlightCoordinator({
    validate: async ({ fencingToken }) => {
      calls += 1;
      return { result: "UNCHANGED", fencingToken };
    }
  });
  const first = coordinator.validate({ scope: scope() });
  const same = coordinator.validate({ scope: scope({ scopes: ["read:status", "read:head"] }) });
  const different = coordinator.validate({ scope: scope({ authorizationContextDigest: "auth:writer" }) });
  assert.strictEqual(first, same);
  assert.notStrictEqual(first, different);
  await Promise.all([first, different]);
  assert.equal(calls, 2);
});

test("legacy fenced requests remain callable but never create a partial sharing key", async () => {
  let calls = 0;
  const coordinator = new FencedSingleFlightCoordinator({
    validate: async ({ fencingToken }) => {
      calls += 1;
      return { result: "UNCHANGED", fencingToken };
    }
  });
  const request = { tenantId: "tenant:acme", resource: "resource:repo", expectedVersion: { scheme: "github.commit", token: "commit:a" } };
  const first = coordinator.validate(request);
  const second = coordinator.validate(request);
  assert.notStrictEqual(first, second);
  await Promise.all([first, second]);
  assert.equal(calls, 2);
});
