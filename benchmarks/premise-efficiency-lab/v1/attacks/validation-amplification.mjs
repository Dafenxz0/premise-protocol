import {
  bundleWithPrivateData,
  createPublicFixture,
  identifier,
  randomFor,
  resolveOptions,
  token,
  toPublicData
} from "./common.mjs";

export const FIXTURE_TYPE = "validation-amplification";
const DEFAULT_SEED = "efficiency-lab-v1-validation-amplification";
const DELIVERY_PATTERNS = Object.freeze(["ordered", "duplicate", "late", "gap"]);

function shuffledIndexes(count, random) {
  const values = Array.from({ length: count }, (_, index) => index);
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [values[index], values[other]] = [values[other], values[index]];
  }
  return values;
}

function makeData(options) {
  const random = randomFor(options.seed, FIXTURE_TYPE);
  const sourceId = identifier("source", options.seed, "shared");
  const sourceUri = `source://efficiency-lab/${sourceId}`;
  const sourceVersion = `v1-${token(options.seed, "source-version")}`;
  const coalescingKey = token(options.seed, "validation-scope");
  const order = shuffledIndexes(options.consumerCount, random);
  const consumers = Array.from({ length: options.consumerCount }, (_, index) => ({
    consumerId: identifier("consumer", options.seed, "consumer", index),
    dependencyId: sourceId,
    queryDigest: token(options.seed, "query", index),
    projectionDigest: token(options.seed, "projection", index),
    observedVersion: sourceVersion,
    requestClass: index % 2 === 0 ? "critical-read" : "dependent-read"
  }));
  const requests = order.map((consumerIndex, arrivalRank) => ({
    requestId: identifier("request", options.seed, "request", arrivalRank),
    consumerId: consumers[consumerIndex].consumerId,
    dependencyId: sourceId,
    scopeDigest: coalescingKey,
    arrivalRank,
    operation: "validate"
  }));
  const waves = Array.from({ length: options.horizonSteps }, (_, index) => ({
    step: index + 1,
    signalId: identifier("signal", options.seed, "signal", index),
    delivery: DELIVERY_PATTERNS[index % DELIVERY_PATTERNS.length],
    requestCount: options.consumerCount,
    sharedDependencyCount: 1,
    scopeDigest: coalescingKey
  }));

  return {
    source: {
      sourceId,
      uri: sourceUri,
      observedVersion: sourceVersion,
      capability: "conditional-read"
    },
    consumers,
    requests,
    waves,
    pressure: {
      sharedDependencyCount: 1,
      consumerCount: options.consumerCount,
      waveCount: options.horizonSteps,
      requestCount: options.consumerCount * options.horizonSteps
    },
    protocol: {
      coalescingKey,
      allowedOperations: ["read", "validate", "conditional-read"],
      deliveryPatterns: DELIVERY_PATTERNS
    }
  };
}

export function generateValidationAmplification(options = {}) {
  const resolved = resolveOptions(options, DEFAULT_SEED);
  return createPublicFixture(FIXTURE_TYPE, resolved, makeData(resolved));
}

export const generateValidationAmplificationFixture = generateValidationAmplification;
export const createValidationAmplification = generateValidationAmplification;
export const generateValidationAmplificationAttack = generateValidationAmplification;

export function createValidationAmplificationOracle(fixture) {
  const publicData = toPublicData(fixture);
  return {
    sourceChanged: true,
    affectedConsumerIds: publicData.consumers.map(({ consumerId }) => consumerId),
    requiredValidationCount: 1,
    repeatedValidationCount: publicData.pressure.requestCount,
    waveCount: publicData.waves.length,
    deliveryPatterns: [...DELIVERY_PATTERNS]
  };
}

export function generateValidationAmplificationBundle(options = {}) {
  const fixture = generateValidationAmplification(options);
  return bundleWithPrivateData(fixture, createValidationAmplificationOracle(fixture));
}

export const createValidationAmplificationBundle = generateValidationAmplificationBundle;
