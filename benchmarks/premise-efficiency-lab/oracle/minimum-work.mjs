const UNKNOWN = "UNKNOWN";

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function known(value) {
  return value !== UNKNOWN && value !== null && finiteNonNegative(value);
}

/**
 * Returns the irreducible work for a scenario, not the work a candidate chose
 * to perform. Missing evidence stays UNKNOWN so a candidate cannot manufacture
 * a favourable amplification denominator.
 */
export function minimumWork(scenario = {}) {
  const external = scenario.externalMinimum ?? (
    scenario.actionRequiresFreshSource === true ? 1 : scenario.changedAffectsAction === true ? 1 : 0
  );
  const validation = scenario.validationMinimum ?? (scenario.changedAffectsAction === true ? 1 : 0);
  const graph = scenario.graphMinimum ?? (scenario.changedAffectsAction === true ? 1 : 0);
  const protocol = scenario.protocolMinimum ?? 1;
  return Object.freeze({ external, validation, graph, protocol });
}

export function workAmplification(actual = {}, minimum = {}) {
  const fields = new Set([...Object.keys(actual), ...Object.keys(minimum)]);
  return Object.fromEntries([...fields].map((field) => {
    const left = actual[field];
    const right = minimum[field];
    if (left === UNKNOWN || right === UNKNOWN) return [field, UNKNOWN];
    if (left === null || right === null) return [field, null];
    if (!finiteNonNegative(left) || !finiteNonNegative(right) || right === 0) return [field, UNKNOWN];
    return [field, left / right];
  }));
}

export function isKnownMinimum(value) {
  return value === UNKNOWN || value === null || known(value);
}
