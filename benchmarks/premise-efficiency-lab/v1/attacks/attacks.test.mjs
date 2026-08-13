import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTACK_TYPES,
  PROFILE_SPECS,
  assertPublicData,
  generateAttackBundle,
  generateAttackDataset,
  generateAttackFixture,
  generateAttackFixtures,
  publicAttackData,
  resolveProfile
} from "./index.mjs";
import { RECEIPT_CACHE_MODES } from "./receipt-cache-adversarial.mjs";

const PROFILES = ["smoke", "medium", "diagnostic"];

function assertNoPrivateKeys(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoPrivateKeys(child, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(key.toLowerCase(), "oracle", `${path}.${key}`);
    assert.notEqual(key.toLowerCase(), "truth", `${path}.${key}`);
    assert.notEqual(key.toLowerCase(), "expecteddecision", `${path}.${key}`);
    assert.notEqual(key.toLowerCase(), "groundtruth", `${path}.${key}`);
    assertNoPrivateKeys(child, `${path}.${key}`);
  }
}

test("all four attack fixture families are deterministic and seed-sensitive", () => {
  for (const type of ATTACK_TYPES) {
    const first = generateAttackFixture(type, { profile: "smoke", seed: "attack-seed" });
    const second = generateAttackFixture(type, { profile: "smoke", seed: "attack-seed" });
    const other = generateAttackFixture(type, { profile: "smoke", seed: "other-seed" });
    assert.deepEqual(first, second, `${type} should be reproducible`);
    assert.notEqual(first.publicHash, other.publicHash, `${type} should vary by seed`);
    assert.equal(first.public, publicAttackData(first));
  }
});

test("smoke, medium, and diagnostic profiles expose the frozen scale dimensions", () => {
  for (const profile of PROFILES) {
    const fixtures = generateAttackFixtures({ profile, seed: 20260813 });
    for (const type of ATTACK_TYPES) {
      const fixture = fixtures[type];
      const spec = PROFILE_SPECS[profile];
      assert.equal(fixture.profile, profile);
      assert.deepEqual(fixture.dimensions, spec);
      assert.equal(fixture.public.profile, profile);
      assertNoPrivateKeys(fixture);
    }
  }
});

test("validation amplification creates shared dependency fan-out over repeated waves", () => {
  const fixture = generateAttackFixture("validation-amplification", { profile: "smoke", seed: 7 });
  assert.equal(fixture.consumers.length, 10);
  assert.equal(fixture.requests.length, 10);
  assert.equal(fixture.waves.length, 10);
  assert.equal(fixture.pressure.requestCount, 100);
  assert.equal(new Set(fixture.requests.map(({ scopeDigest }) => scopeDigest)).size, 1);
  assert.deepEqual(new Set(fixture.waves.map(({ delivery }) => delivery)), new Set(["ordered", "duplicate", "late", "gap"]));
});

test("single-flight stampede keeps the shared scope separate from a decoy scope", () => {
  const fixture = generateAttackFixture("single-flight-stampede", { profile: "smoke", seed: "stampede" });
  assert.equal(fixture.requests.length, 10);
  assert.equal(new Set(fixture.requests.map(({ scopeDigest }) => scopeDigest)).size, 1);
  assert.notEqual(fixture.requests[0].scopeDigest, fixture.isolationRequests[0].scopeDigest);
  assert.equal(fixture.burst.sharedRequestCount, 10);
  assert.equal(fixture.burst.waveCount, 10);
});

test("long-horizon drift covers the requested horizon and delivery hazards", () => {
  const fixture = generateAttackFixture("long-horizon-drift", { profile: "medium", seed: 11 });
  assert.equal(fixture.timeline.length, 100);
  assert.deepEqual(fixture.timeline.map(({ step }) => step), Array.from({ length: 100 }, (_, index) => index + 1));
  assert.deepEqual(
    new Set(fixture.timeline.map(({ signal }) => signal.delivery)),
    new Set(["ordered", "late", "duplicate", "gap", "reconnect"])
  );
  assert.ok(fixture.timeline.some(({ incarnationToken }) => incarnationToken !== fixture.timeline[0].incarnationToken));
});

test("receipt/cache fixture covers every public attack mode without exposing labels", () => {
  const fixture = generateAttackFixture("receipt-cache-adversarial", { profile: "smoke", seed: 19 });
  assert.equal(fixture.attempts.length, 10);
  assert.deepEqual(new Set(fixture.attempts.map(({ attackMode }) => attackMode)), new Set(RECEIPT_CACHE_MODES));
  assert.deepEqual(fixture.cache.namespaceFields, ["tenantId", "resourceId", "queryDigest", "causalFrontierDigest", "generationToken"]);
  assertNoPrivateKeys(fixture);
});

test("explicit oracle bundles keep private classifications outside public data", () => {
  const requiredPrivateFields = {
    "validation-amplification": "requiredValidationCount",
    "single-flight-stampede": "minimumLeaders",
    "long-horizon-drift": "driftSteps",
    "receipt-cache-adversarial": "classifications"
  };
  for (const type of ATTACK_TYPES) {
    const bundle = generateAttackBundle(type, { profile: "smoke", seed: "bundle" });
    assert.ok(Object.hasOwn(bundle.private, requiredPrivateFields[type]));
    assertNoPrivateKeys(bundle.public);
    assert.equal(JSON.stringify(bundle.public).includes(requiredPrivateFields[type]), false);
  }
});

test("public dataset and boundary validator reject oracle-shaped fields", () => {
  const dataset = generateAttackDataset({ profile: "smoke", seed: 23 });
  assertNoPrivateKeys(dataset);
  assert.throws(() => assertPublicData({ observation: { expectedDecision: "ALLOW" } }), /private evaluator field/iu);
  assert.throws(() => assertPublicData({ cache: { hidden_labels: ["secret"] } }), /private evaluator field/iu);
});

test("profile aliases resolve to the diagnostic scale and invalid profiles fail closed", () => {
  assert.equal(resolveProfile("diagnostic-xl").nodeCount, 100_000);
  assert.equal(resolveProfile("diagnostic-1m").nodeCount, 1_000_000);
  assert.throws(() => resolveProfile("tiny"), /unknown profile/iu);
});
