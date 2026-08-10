import assert from "node:assert/strict";
import {
  ExternalKeyResolver,
  SecurityError,
  createKeyRingFromProvider
} from "../dist/index.js";

const keyBytes = (seed, length = 32) => Uint8Array.from({ length }, (_, index) => (seed + index) & 0xff);
const tenant = "tenant:acme";
const active = { tenantId: tenant, keyId: "enc-v1", version: "v1", algorithm: "aes-256-gcm" };
const previous = { tenantId: tenant, keyId: "enc-v0", version: "v0", algorithm: "aes-256-gcm" };
const rotated = { tenantId: tenant, keyId: "enc-v2", version: "v2", algorithm: "aes-256-gcm" };

const assertError = async (operation, code, message = undefined) => {
  await assert.rejects(operation, (error) => {
    assert.equal(error instanceof SecurityError, true);
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(String(error).includes(message), false);
    return true;
  });
};

let now = 0;
let calls = 0;
const provider = {
  async resolve(reference) {
    calls += 1;
    return { ...reference, material: keyBytes(calls) };
  }
};

const resolver = new ExternalKeyResolver({ provider, cacheTtlMs: 100, now: () => now });
const first = await resolver.resolve(active);
assert.equal(calls, 1);
first.material[0] = 255;
const cached = await resolver.resolve(active);
assert.equal(calls, 1, "fresh material should be served from the tenant/version-bound cache");
assert.equal(cached.material[0], 1, "callers must not mutate cached key material");
now = 99;
await resolver.resolve(active);
assert.equal(calls, 1);
now = 100;
await resolver.resolve(active);
assert.equal(calls, 2, "expired material must be resolved again, never served stale");
resolver.invalidate(active);
await resolver.resolve(active);
assert.equal(calls, 3, "explicit invalidation must force a provider resolution");
resolver.clear();
await resolver.resolve(active);
assert.equal(calls, 4, "clear must invalidate all cached material");

await resolver.resolve({ ...active, version: "v1-next" });
await resolver.resolve({ ...active, tenantId: "tenant:other" });
assert.equal(calls, 6, "tenant, keyId, version and algorithm must all bind the cache key");

let release;
let slowCalls = 0;
const slowProvider = {
  async resolve(reference) {
    slowCalls += 1;
    await new Promise((resolvePromise) => { release = resolvePromise; });
    return { ...reference, material: keyBytes(9) };
  }
};
const slowResolver = new ExternalKeyResolver({ provider: slowProvider, cacheTtlMs: 100, now: () => 0 });
const inFlightFirst = slowResolver.resolve(active);
const inFlightSecond = slowResolver.resolve(active);
await Promise.resolve();
assert.equal(slowCalls, 1, "concurrent resolutions must share one provider call");
release();
await Promise.all([inFlightFirst, inFlightSecond]);

let releaseInvalidated;
const invalidatingProvider = {
  async resolve(reference) {
    await new Promise((resolvePromise) => { releaseInvalidated = resolvePromise; });
    return { ...reference, material: keyBytes(10) };
  }
};
const invalidatingResolver = new ExternalKeyResolver({ provider: invalidatingProvider, now: () => 0 });
const invalidatedResolution = invalidatingResolver.resolve(active);
await Promise.resolve();
invalidatingResolver.invalidate(active);
releaseInvalidated();
await assertError(() => invalidatedResolution, "CONFIGURATION_ERROR");

const throwingSecret = "kms-material-that-must-never-appear-in-errors";
const throwingResolver = new ExternalKeyResolver({
  provider: { async resolve() { throw new Error(throwingSecret); } },
  now: () => 0
});
await assertError(() => throwingResolver.resolve(active), "CONFIGURATION_ERROR", throwingSecret);
await assertError(() => new ExternalKeyResolver({ now: () => 0 }).resolve(active), "CONFIGURATION_ERROR");

for (const invalidReference of [
  { ...active, keyId: "*" },
  { ...active, version: "" },
  { ...active, algorithm: "rsa-oaep" },
  { ...active, tenantId: "*" }
]) {
  await assertError(() => resolver.resolve(invalidReference), "INVALID_INPUT");
}

for (const invalidMaterial of [
  undefined,
  { ...active, material: keyBytes(1, 31) },
  { ...active, tenantId: "tenant:other", material: keyBytes(1) },
  { ...active, version: "v9", material: keyBytes(1) },
  { ...active, algorithm: "rsa-oaep", material: keyBytes(1) }
]) {
  const invalidResolver = new ExternalKeyResolver({
    provider: { async resolve() { return invalidMaterial; } },
    now: () => 0
  });
  await assertError(() => invalidResolver.resolve(active), "CONFIGURATION_ERROR");
}

let ringRandomCounter = 0;
const ring = await resolver.createKeyRing({
  tenantId: tenant,
  active,
  previous: [previous],
  randomBytes: (size) => Uint8Array.from({ length: size }, () => ++ringRandomCounter)
});
assert.equal(ring.activeKeyId, "enc-v1");
const encrypted = ring.encrypt({ version: 1 }, { associatedData: tenant });
assert.deepEqual(ring.decrypt(encrypted, { expectedAssociatedData: tenant }), { version: 1 });

await assertError(() => resolver.createKeyRing({ tenantId: tenant, active, previous: [{ ...previous, tenantId: "tenant:other" }] }), "CONFIGURATION_ERROR");
await assertError(() => resolver.createKeyRing({ tenantId: tenant, active, previous: [{ ...previous, keyId: active.keyId }] }), "CONFIGURATION_ERROR");

const rotatedRing = await resolver.rotateKeyRing({
  tenantId: tenant,
  active: rotated,
  previous: [active],
  randomBytes: (size) => Uint8Array.from({ length: size }, () => ++ringRandomCounter)
});
assert.equal(rotatedRing.activeKeyId, rotated.keyId);
assert.equal(calls >= 9, true, "rotation must invalidate and explicitly re-resolve the requested key set");

const oneShotRing = await createKeyRingFromProvider({
  provider,
  cacheTtlMs: 1_000,
  now: () => 0,
  tenantId: tenant,
  active: rotated
});
assert.equal(oneShotRing.activeKeyId, rotated.keyId);

await assertError(() => createKeyRingFromProvider({
  provider: undefined,
  tenantId: tenant,
  active
}), "CONFIGURATION_ERROR");

console.log("external key provider deterministic tests passed; no network provider was used");
