import { createSeededRandom, normalizeSeed, stableHash } from "../../generators/graphs.mjs";

export const FORMAT = "premise-efficiency-lab/v1/attacks";

export const ATTACK_TYPES = Object.freeze([
  "validation-amplification",
  "single-flight-stampede",
  "long-horizon-drift",
  "receipt-cache-adversarial"
]);

const PROFILE_VALUES = Object.freeze({
  smoke: { nodeCount: 100, consumerCount: 10, horizonSteps: 10, diagnostic: false },
  medium: { nodeCount: 1_000, consumerCount: 100, horizonSteps: 100, diagnostic: false },
  large: { nodeCount: 10_000, consumerCount: 1_000, horizonSteps: 1_000, diagnostic: false },
  diagnostic: { nodeCount: 100_000, consumerCount: 1_000, horizonSteps: 1_000, diagnostic: true },
  "diagnostic-xl": { nodeCount: 100_000, consumerCount: 1_000, horizonSteps: 1_000, diagnostic: true },
  "diagnostic-100k": { nodeCount: 100_000, consumerCount: 1_000, horizonSteps: 1_000, diagnostic: true },
  "diagnostic-xxl": { nodeCount: 1_000_000, consumerCount: 1_000, horizonSteps: 1_000, diagnostic: true },
  "diagnostic-1m": { nodeCount: 1_000_000, consumerCount: 1_000, horizonSteps: 1_000, diagnostic: true }
});

export const PROFILES = Object.freeze(["smoke", "medium", "diagnostic"]);
export const PROFILE_SPECS = Object.freeze(
  Object.fromEntries(Object.entries(PROFILE_VALUES).map(([name, value]) => [name, Object.freeze({ ...value })]))
);
export const PROFILE_CONFIGS = PROFILE_SPECS;

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "oracle",
  "truth",
  "sourcetruth",
  "expected",
  "expecteddecision",
  "expectedoutcome",
  "oracledecision",
  "oraclelabel",
  "oraclelabels",
  "oracleresult",
  "privateoracle",
  "affectedset",
  "actualaffectedtarget",
  "groundtruth",
  "trueversion",
  "candidatename",
  "mapping",
  "candidatemapping",
  "hiddenlabels",
  "hiddenlabel",
  "label",
  "labels",
  "mutation",
  "mutations",
  "outcome",
  "objective",
  "evaluator",
  "private"
]);

function keyName(value) {
  return value.replaceAll("_", "").replaceAll("-", "").toLowerCase();
}

function assertOptions(options) {
  if (options === undefined) return {};
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  return options;
}

function positiveInteger(value, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new RangeError(`${name} must be a safe integer in [1, ${maximum}]`);
  }
  return result;
}

function profileName(value) {
  const result = String(value ?? "smoke").trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
  if (!Object.hasOwn(PROFILE_VALUES, result)) {
    throw new RangeError(`unknown profile: ${value}; expected ${Object.keys(PROFILE_VALUES).join(", ")}`);
  }
  return result;
}

export function resolveProfile(value = "smoke") {
  const name = profileName(value);
  return Object.freeze({ name, ...PROFILE_SPECS[name] });
}

export function resolveOptions(value, defaultSeed) {
  const options = assertOptions(value);
  const profile = resolveProfile(options.profile);
  const seed = normalizeSeed(options.seed ?? defaultSeed);
  return Object.freeze({
    profile: profile.name,
    seed,
    nodeCount: positiveInteger(options.nodeCount ?? options.nodes ?? options.size, "nodeCount", profile.nodeCount),
    consumerCount: positiveInteger(options.consumerCount ?? options.consumers, "consumerCount", profile.consumerCount, 100_000),
    horizonSteps: positiveInteger(options.horizonSteps ?? options.horizon ?? options.steps, "horizonSteps", profile.horizonSteps, 100_000),
    diagnostic: profile.diagnostic
  });
}

export function randomFor(seed, label) {
  return createSeededRandom(`${seed}:${label}`);
}

export function digest(value) {
  return stableHash(value);
}

export function token(seed, label, index = undefined) {
  return digest({ seed, label, index }).slice(7, 23);
}

export function identifier(prefix, seed, label, index = undefined) {
  return `${prefix}-${token(seed, label, index)}`;
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function assertPublicData(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertPublicData(child, `${path}[${index}]`));
    return value;
  }
  if (!value || typeof value !== "object") return value;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PUBLIC_KEYS.has(keyName(key))) {
      throw new Error(`private evaluator field ${path}.${key} crossed the public boundary`);
    }
    assertPublicData(child, `${path}.${key}`);
  }
  return value;
}

export function createPublicFixture(fixtureType, options, data) {
  const base = {
    format: `${FORMAT}/public`,
    fixtureType,
    profile: options.profile,
    seed: options.seed,
    fixtureId: identifier("attack", options.seed, fixtureType),
    dimensions: {
      nodeCount: options.nodeCount,
      consumerCount: options.consumerCount,
      horizonSteps: options.horizonSteps,
      diagnostic: options.diagnostic
    },
    ...data
  };
  assertPublicData(base);
  const publicHash = digest(base);
  const publicData = deepFreeze({ ...base, publicHash });
  assertPublicData(publicData);
  return deepFreeze({ ...publicData, public: publicData });
}

export function toPublicData(value) {
  const result = value?.public ?? value?.publicData ?? value;
  assertPublicData(result);
  return result;
}

export function createPublicManifest(fixtures) {
  const values = Array.isArray(fixtures) ? fixtures : Object.values(fixtures ?? {});
  const publicFixtures = values.map(toPublicData);
  const first = publicFixtures[0];
  const manifest = {
    format: `${FORMAT}/manifest`,
    profile: first?.profile ?? null,
    seed: first?.seed ?? null,
    fixtureCount: publicFixtures.length,
    fixtureTypes: publicFixtures.map((fixture) => fixture.fixtureType),
    datasetHash: digest(publicFixtures)
  };
  assertPublicData(manifest);
  return deepFreeze(manifest);
}

export function bundleWithPrivateData(publicFixture, privateData) {
  const publicData = toPublicData(publicFixture);
  return deepFreeze({
    format: `${FORMAT}/bundle`,
    fixtureType: publicData.fixtureType,
    profile: publicData.profile,
    seed: publicData.seed,
    public: publicData,
    private: deepFreeze(privateData)
  });
}

export { FORBIDDEN_PUBLIC_KEYS };
