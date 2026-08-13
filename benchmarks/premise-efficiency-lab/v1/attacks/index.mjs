import {
  ATTACK_TYPES,
  createPublicManifest,
  deepFreeze,
  resolveOptions,
  toPublicData
} from "./common.mjs";
import {
  FIXTURE_TYPE as VALIDATION_AMPLIFICATION,
  generateValidationAmplification,
  generateValidationAmplificationBundle
} from "./validation-amplification.mjs";
import {
  FIXTURE_TYPE as SINGLE_FLIGHT_STAMPEDE,
  generateSingleFlightStampede,
  generateSingleFlightStampedeBundle
} from "./single-flight-stampede.mjs";
import {
  FIXTURE_TYPE as LONG_HORIZON_DRIFT,
  generateLongHorizonDrift,
  generateLongHorizonDriftBundle
} from "./long-horizon-drift.mjs";
import {
  FIXTURE_TYPE as RECEIPT_CACHE_ADVERSARIAL,
  generateReceiptCacheAdversarial,
  generateReceiptCacheAdversarialBundle
} from "./receipt-cache-adversarial.mjs";

export * from "./common.mjs";
export * from "./validation-amplification.mjs";
export * from "./single-flight-stampede.mjs";
export * from "./long-horizon-drift.mjs";
export * from "./receipt-cache-adversarial.mjs";

const GENERATORS = Object.freeze({
  [VALIDATION_AMPLIFICATION]: generateValidationAmplification,
  [SINGLE_FLIGHT_STAMPEDE]: generateSingleFlightStampede,
  [LONG_HORIZON_DRIFT]: generateLongHorizonDrift,
  [RECEIPT_CACHE_ADVERSARIAL]: generateReceiptCacheAdversarial
});

const BUNDLE_GENERATORS = Object.freeze({
  [VALIDATION_AMPLIFICATION]: generateValidationAmplificationBundle,
  [SINGLE_FLIGHT_STAMPEDE]: generateSingleFlightStampedeBundle,
  [LONG_HORIZON_DRIFT]: generateLongHorizonDriftBundle,
  [RECEIPT_CACHE_ADVERSARIAL]: generateReceiptCacheAdversarialBundle
});

const TYPE_ALIASES = Object.freeze({
  validation: VALIDATION_AMPLIFICATION,
  "validation-amplification-attack": VALIDATION_AMPLIFICATION,
  "single-flight": SINGLE_FLIGHT_STAMPEDE,
  stampede: SINGLE_FLIGHT_STAMPEDE,
  "single-flight-attack": SINGLE_FLIGHT_STAMPEDE,
  drift: LONG_HORIZON_DRIFT,
  "long-horizon": LONG_HORIZON_DRIFT,
  "long-horizon-drift-attack": LONG_HORIZON_DRIFT,
  "receipt-cache": RECEIPT_CACHE_ADVERSARIAL,
  "receipt-cache-attack": RECEIPT_CACHE_ADVERSARIAL,
  "receipt-cache-attacks": RECEIPT_CACHE_ADVERSARIAL
});

export const ATTACK_GENERATORS = GENERATORS;

function normalizeType(value) {
  const key = String(value ?? "").trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
  const type = TYPE_ALIASES[key] ?? key;
  if (!Object.hasOwn(GENERATORS, type)) {
    throw new RangeError(`unknown attack fixture: ${value}; expected ${ATTACK_TYPES.join(", ")}`);
  }
  return type;
}

export function generateAttackFixture(type, options = {}) {
  return GENERATORS[normalizeType(type)](options);
}

export const createAttackFixture = generateAttackFixture;

export function generateAttackFixtures(options = {}) {
  return deepFreeze(Object.fromEntries(ATTACK_TYPES.map((type) => [type, GENERATORS[type](options)])));
}

export const generateAllAttackFixtures = generateAttackFixtures;
export const createAttackFixtures = generateAttackFixtures;

export function generateAttackDataset(options = {}) {
  const resolved = resolveOptions(options, "efficiency-lab-v1-attacks");
  const fixtures = generateAttackFixtures(resolved);
  const manifest = createPublicManifest(fixtures);
  const dataset = {
    format: "premise-efficiency-lab/v1/attack-dataset/public",
    profile: resolved.profile,
    seed: resolved.seed,
    fixtures,
    manifest
  };
  return deepFreeze(dataset);
}

export const createAttackDataset = generateAttackDataset;

export function generateAttackBundle(type, options = {}) {
  return BUNDLE_GENERATORS[normalizeType(type)](options);
}

export function generateAttackBundles(options = {}) {
  return deepFreeze(Object.fromEntries(ATTACK_TYPES.map((type) => [type, BUNDLE_GENERATORS[type](options)])));
}

export function publicAttackManifest(value) {
  if (value && !Array.isArray(value) && value.fixtures) return value.manifest ?? createPublicManifest(value.fixtures);
  return createPublicManifest(value);
}

export function publicAttackData(value) {
  return toPublicData(value);
}

export { createPublicManifest };
