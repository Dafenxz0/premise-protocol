/**
 * IndependentSmart is a deliberately separate baseline. It owns its cache,
 * TTL and volatility heuristic and imports no PREMiSE runtime or policy
 * internals. It is a comparator, not a protocol implementation.
 */

const RISK_WEIGHT = Object.freeze({ LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 });

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function keyOf(task) {
  return [task.tenantId, task.resourceId, task.scopeDigest ?? "default", task.queryDigest ?? "default"].join("|");
}

function assertVersion(value) {
  if (!value || typeof value !== "object" || typeof value.scheme !== "string" || typeof value.token !== "string") {
    throw new TypeError("IndependentSmart requires an opaque version object");
  }
}

function sameVersion(left, right) {
  return left?.scheme === right?.scheme && left?.token === right?.token;
}

function bounded(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function createIndependentSmart(options = {}) {
  const baseTtl = Math.max(0, Number(options.baseTtl ?? 8));
  const minTtl = Math.max(0, Number(options.minTtl ?? 1));
  const maxTtl = Math.max(minTtl, Number(options.maxTtl ?? 64));
  const cache = new Map();

  function ttlFor(entry) {
    const volatility = bounded(entry?.volatility ?? 0, 0, 1);
    return bounded(Math.round(baseTtl * (1 - volatility)), minTtl, maxTtl);
  }

  function observe(entry, changed) {
    const prior = entry?.volatility ?? 0;
    return bounded(prior * 0.75 + (changed ? 0.25 : 0), 0, 1);
  }

  async function execute(task, tools) {
    if (!task || typeof task !== "object") throw new TypeError("task is required");
    if (!tools || typeof tools.read !== "function" || typeof tools.actIfVersion !== "function") {
      throw new TypeError("IndependentSmart requires read and actIfVersion tools");
    }
    assertVersion(task.observedVersion);
    const cacheKey = keyOf(task);
    const previous = cache.get(cacheKey);
    const age = previous === undefined ? Number.POSITIVE_INFINITY : Math.max(0, task.logicalTime - previous.checkedAt);
    const risk = RISK_WEIGHT[task.risk ?? "LOW"] ?? RISK_WEIGHT.MEDIUM;
    const eventHint = Array.isArray(task.events) && task.events.some((event) => event?.resourceId === task.resourceId && event?.version);
    const mustRead = previous === undefined || age >= ttlFor(previous) || eventHint || risk >= RISK_WEIGHT.HIGH;
    const trace = { reads: 0, validations: 0, actions: 0, decisions: [] };
    let observation = previous?.observation;
    let expectedVersion = previous?.version ?? task.observedVersion;

    if (mustRead) {
      observation = clone(await tools.read());
      trace.reads += 1;
      trace.validations += 1;
      if (!observation || typeof observation !== "object") throw new TypeError("read must return an observation");
      assertVersion(observation.version);
      const changed = previous !== undefined && !sameVersion(previous.version, observation.version);
      const entry = {
        version: clone(observation.version),
        observation: clone(observation),
        checkedAt: task.logicalTime,
        volatility: observe(previous, changed)
      };
      cache.set(cacheKey, entry);
      expectedVersion = observation.version;
      trace.decisions.push(changed ? "REVALIDATED_CHANGED" : "REVALIDATED");
    } else {
      trace.decisions.push("CACHE_REUSE");
    }

    const action = await tools.actIfVersion(expectedVersion, clone(task.action));
    trace.actions += 1;
    const accepted = Boolean(action?.accepted);
    if (!accepted && action?.reason === "VERSION_MISMATCH") {
      const current = cache.get(cacheKey);
      if (current !== undefined) current.volatility = observe(current, true);
    }
    return Object.freeze({
      decision: accepted ? "ACTION_ACCEPTED" : "ACTION_REJECTED",
      accepted,
      expectedVersion: clone(expectedVersion),
      trace: Object.freeze({ ...trace, decisions: Object.freeze([...trace.decisions]) })
    });
  }

  return Object.freeze({ execute, cacheSize: () => cache.size, ttlFor });
}

export const independentSmartContract = Object.freeze({
  name: "IndependentSmart",
  importsPremiseInternals: false,
  safetyRule: "conditional action is always delegated to the source adapter",
  tuning: "dynamic TTL from observed version volatility and risk"
});
