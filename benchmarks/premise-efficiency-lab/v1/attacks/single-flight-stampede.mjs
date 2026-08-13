import {
  bundleWithPrivateData,
  createPublicFixture,
  identifier,
  randomFor,
  resolveOptions,
  token,
  toPublicData
} from "./common.mjs";

export const FIXTURE_TYPE = "single-flight-stampede";
const DEFAULT_SEED = "efficiency-lab-v1-single-flight-stampede";

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
  const resourceId = identifier("resource", options.seed, "resource");
  const tenantId = identifier("tenant", options.seed, "tenant");
  const principalId = identifier("principal", options.seed, "principal");
  const scopeDigest = token(options.seed, "shared-scope");
  const sourceVersion = `v1-${token(options.seed, "source-version")}`;
  const order = shuffledIndexes(options.consumerCount, random);
  const requests = order.map((consumerIndex, arrivalRank) => ({
    requestId: identifier("request", options.seed, "shared-request", arrivalRank),
    consumerId: identifier("consumer", options.seed, "consumer", consumerIndex),
    arrivalRank,
    scopeDigest,
    operation: "validate",
    barrier: "source-read-release"
  }));
  const isolationScopeDigest = token(options.seed, "isolation-scope");
  const isolationRequests = [{
    requestId: identifier("request", options.seed, "isolation-request"),
    consumerId: identifier("consumer", options.seed, "isolation"),
    arrivalRank: options.consumerCount,
    scopeDigest: isolationScopeDigest,
    operation: "validate",
    barrier: "source-read-release"
  }];

  return {
    resource: {
      resourceId,
      uri: `source://efficiency-lab/${resourceId}`,
      observedVersion: sourceVersion
    },
    scope: {
      tenantId,
      principalId,
      resourceId,
      queryDigest: token(options.seed, "query"),
      projectionDigest: token(options.seed, "projection"),
      causalFrontierDigest: token(options.seed, "causal-frontier"),
      scopeDigest
    },
    requests,
    isolationRequests,
    burst: {
      mode: "simultaneous",
      sharedRequestCount: requests.length,
      isolatedRequestCount: isolationRequests.length,
      waveCount: options.horizonSteps,
      release: "after-shared-source-read"
    },
    protocol: {
      singleFlightScope: scopeDigest,
      allowedOperations: ["receipt-lookup", "validate", "conditional-read"],
      joinWindowSteps: options.horizonSteps
    }
  };
}

export function generateSingleFlightStampede(options = {}) {
  const resolved = resolveOptions(options, DEFAULT_SEED);
  return createPublicFixture(FIXTURE_TYPE, resolved, makeData(resolved));
}

export const generateSingleFlightStampedeFixture = generateSingleFlightStampede;
export const createSingleFlightStampede = generateSingleFlightStampede;
export const generateSingleFlightStampedeAttack = generateSingleFlightStampede;

export function createSingleFlightStampedeOracle(fixture) {
  const publicData = toPublicData(fixture);
  return {
    sharedRequestCount: publicData.requests.length,
    minimumLeaders: 1,
    expectedJoins: Math.max(0, publicData.requests.length - 1),
    isolationRequestCount: publicData.isolationRequests.length,
    sharedScopeDigest: publicData.scope.scopeDigest,
    isolationScopeDigest: publicData.isolationRequests[0].scopeDigest
  };
}

export function generateSingleFlightStampedeBundle(options = {}) {
  const fixture = generateSingleFlightStampede(options);
  return bundleWithPrivateData(fixture, createSingleFlightStampedeOracle(fixture));
}

export const createSingleFlightStampedeBundle = generateSingleFlightStampedeBundle;
