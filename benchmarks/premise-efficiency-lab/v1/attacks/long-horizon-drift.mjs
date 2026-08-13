import {
  bundleWithPrivateData,
  createPublicFixture,
  identifier,
  randomFor,
  resolveOptions,
  token,
  toPublicData
} from "./common.mjs";

export const FIXTURE_TYPE = "long-horizon-drift";
const DEFAULT_SEED = "efficiency-lab-v1-long-horizon-drift";
const DELIVERY_MODES = Object.freeze(["ordered", "late", "duplicate", "gap", "reconnect"]);

function makeTimeline(options) {
  const random = randomFor(options.seed, FIXTURE_TYPE);
  const sourceId = identifier("source", options.seed, "source");
  const timeline = [];
  let observedVersion = `v1-${token(options.seed, "version", 0)}`;
  let incarnationToken = token(options.seed, "incarnation", 0);
  for (let index = 0; index < options.horizonSteps; index += 1) {
    const step = index + 1;
    const drift = index > 0 && (step % 7 === 0 || random() < 0.08);
    if (drift) {
      observedVersion = `v${(index % 3) + 2}-${token(options.seed, "version", index)}`;
    }
    if (step % 29 === 0) incarnationToken = token(options.seed, "incarnation", index);
    const delivery = DELIVERY_MODES[index % DELIVERY_MODES.length];
    timeline.push({
      step,
      observedAt: 1_700_000_000_000 + step * 1_000,
      sourceId,
      observedVersion,
      incarnationToken,
      signal: {
        signalId: identifier("signal", options.seed, "signal", index),
        sequence: delivery === "gap" ? step + 1 : step,
        delivery
      },
      causalFrontierDigest: token(options.seed, "frontier", index),
      checkpoint: step === 1 || step === options.horizonSteps || step % Math.max(1, Math.floor(options.horizonSteps / 10)) === 0
    });
  }
  return { sourceId, timeline };
}

export function generateLongHorizonDrift(options = {}) {
  const resolved = resolveOptions(options, DEFAULT_SEED);
  const { sourceId, timeline } = makeTimeline(resolved);
  const publicData = createPublicFixture(FIXTURE_TYPE, resolved, {
    source: {
      sourceId,
      uri: `source://efficiency-lab/${sourceId}`,
      initialVersion: timeline[0].observedVersion,
      initialIncarnationToken: timeline[0].incarnationToken
    },
    horizon: {
      steps: resolved.horizonSteps,
      checkpointCount: timeline.filter(({ checkpoint }) => checkpoint).length,
      compactionWindowSteps: Math.max(1, Math.floor(resolved.horizonSteps / 10))
    },
    timeline,
    protocol: {
      deliveryModes: DELIVERY_MODES,
      allowedOperations: ["observe", "continuity-check", "revalidate", "compact"],
      identityFields: ["sourceId", "observedVersion", "incarnationToken", "causalFrontierDigest"]
    }
  });
  return publicData;
}

export const generateLongHorizonDriftFixture = generateLongHorizonDrift;
export const createLongHorizonDrift = generateLongHorizonDrift;
export const generateLongHorizonDriftAttack = generateLongHorizonDrift;

export function createLongHorizonDriftOracle(fixture) {
  const publicData = toPublicData(fixture);
  const timeline = publicData.timeline;
  return {
    driftSteps: timeline.filter(({ signal }) => signal.delivery !== "ordered").map(({ step }) => step),
    incarnationChanges: new Set(timeline.map(({ incarnationToken }) => incarnationToken)).size - 1,
    continuityBreaks: timeline.filter(({ signal }) => signal.delivery === "gap").map(({ step }) => step),
    lateSignals: timeline.filter(({ signal }) => signal.delivery === "late").map(({ step }) => step),
    horizonSteps: timeline.length
  };
}

export function generateLongHorizonDriftBundle(options = {}) {
  const fixture = generateLongHorizonDrift(options);
  return bundleWithPrivateData(fixture, createLongHorizonDriftOracle(fixture));
}

export const createLongHorizonDriftBundle = generateLongHorizonDriftBundle;
export { DELIVERY_MODES };
