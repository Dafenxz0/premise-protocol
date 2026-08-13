/**
 * Certified minimum-work oracle v1.
 *
 * A number is a usable denominator only when its certificate says how it was
 * obtained.  Exact values come only from a complete, small legal-plan
 * enumeration.  Scalable dimensions use conservative lower bounds derived
 * from explicit evidence.  Missing evidence is UNKNOWN; an explicitly
 * unbounded dimension is UNBOUNDED.
 */

export const ORACLE_FORMAT = "premise-efficiency-lab/oracle/v1";
export const DIMENSIONS = Object.freeze(["graph", "external", "validation", "write"]);
export const EXACT = "EXACT";
export const CERTIFIED_LOWER_BOUND = "CERTIFIED_LOWER_BOUND";
export const UNKNOWN = "UNKNOWN";
export const UNBOUNDED = "UNBOUNDED";
export const MAX_EXACT_PLANS = 4096;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, name) {
  if (!isObject(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finitePositive(value) {
  return finiteNonNegative(value) && value > 0;
}

function uniqueCount(value, name) {
  if (finiteNonNegative(value)) return value;
  if (typeof value === "string" || value === null || value === undefined
    || typeof value[Symbol.iterator] !== "function") {
    throw new TypeError(`${name} must be a non-negative number or iterable`);
  }
  const values = [...value];
  if (values.some((item) => item === undefined || item === null)) {
    throw new TypeError(`${name} must not contain nullish values`);
  }
  return new Set(values).size;
}

function countMaybe(value, name) {
  if (value === undefined) return undefined;
  return uniqueCount(value, name);
}

function hasOwn(value, key) {
  return isObject(value) && Object.hasOwn(value, key);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function freezeObject(value) {
  return Object.freeze(value);
}

function statusOf(value) {
  if (value === UNKNOWN) return UNKNOWN;
  if (value === UNBOUNDED) return UNBOUNDED;
  if (isObject(value)) {
    if (value.mode === UNBOUNDED || value.status === UNBOUNDED || value.value === UNBOUNDED || value.minimum === UNBOUNDED) {
      return UNBOUNDED;
    }
    if (value.mode === UNKNOWN || value.status === UNKNOWN || value.value === UNKNOWN || value.minimum === UNKNOWN) {
      return UNKNOWN;
    }
  }
  return undefined;
}

function unwrapValue(value) {
  if (!isObject(value)) return value;
  const marker = statusOf(value);
  if (marker !== undefined) return marker;
  return firstDefined(value.value, value.minimum, value.lowerBound, value.certifiedLowerBound);
}

function makeEntry(mode, minimum, certificate) {
  return freezeObject({ mode, minimum, certificate: freezeObject(certificate) });
}

function unknownEntry(reason) {
  return makeEntry(UNKNOWN, UNKNOWN, { kind: "UNAVAILABLE", reason });
}

function unboundedEntry(reason) {
  return makeEntry(UNBOUNDED, UNBOUNDED, { kind: "UNBOUNDED", reason });
}

function lowerBoundEntry(dimension, minimum, certificate) {
  if (!finiteNonNegative(minimum)) throw new RangeError(`${dimension} lower bound must be finite and non-negative`);
  return makeEntry(CERTIFIED_LOWER_BOUND, minimum, { dimension, ...certificate });
}

function exactEntry(dimension, minimum, certificate) {
  if (!finiteNonNegative(minimum)) throw new RangeError(`${dimension} exact minimum must be finite and non-negative`);
  return makeEntry(EXACT, minimum, { dimension, ...certificate });
}

function isUnboundedMarker(value) {
  return statusOf(value) === UNBOUNDED;
}

function isUnknownMarker(value) {
  return statusOf(value) === UNKNOWN;
}

function planWork(plan) {
  if (isObject(plan?.work)) return plan.work;
  if (isObject(plan?.cost)) return plan.cost;
  return plan;
}

function planDimensionValue(plan, dimension) {
  const work = planWork(plan);
  if (!isObject(work) || !hasOwn(work, dimension)) return undefined;
  return unwrapValue(work[dimension]);
}

function readPlanModel(model) {
  if (model === undefined) return { kind: "absent" };
  if (Array.isArray(model) || typeof model === "function") model = Array.isArray(model) ? { plans: model } : { enumerate: model };
  assertObject(model, "legalPlanModel");
  if (model.unbounded === true || model.bounded === false) return { kind: UNBOUNDED, reason: "LEGAL_PLAN_SPACE_UNBOUNDED" };
  if (model.unknown === true || model.exhaustive === false || model.complete === false) {
    return { kind: UNKNOWN, reason: "LEGAL_PLAN_ENUMERATION_INCOMPLETE" };
  }

  const maxPlans = model.maxPlans ?? MAX_EXACT_PLANS;
  if (!Number.isSafeInteger(maxPlans) || maxPlans < 1) throw new RangeError("legalPlanModel.maxPlans must be a positive integer");

  let source;
  if (model.plans !== undefined) source = model.plans;
  else if (typeof model.enumerate === "function") source = model.enumerate();
  else if (typeof model.enumeratePlans === "function") source = model.enumeratePlans();
  else return { kind: UNKNOWN, reason: "LEGAL_PLAN_MODEL_NOT_ENUMERABLE" };

  if (source === null || source === undefined || typeof source[Symbol.iterator] !== "function") {
    throw new TypeError("legalPlanModel must provide iterable plans or an iterable enumeration");
  }

  const plans = [];
  for (const plan of source) {
    if (plans.length >= maxPlans) return { kind: UNKNOWN, reason: "LEGAL_PLAN_ENUMERATION_TOO_LARGE" };
    if (!isObject(plan)) throw new TypeError("legal plans must be objects");
    plans.push(plan);
  }
  if (plans.length === 0) return { kind: UNKNOWN, reason: "NO_LEGAL_PLANS" };
  return { kind: "complete", plans, maxPlans };
}

function exactFromPlans(model) {
  if (model.kind !== "complete") return { dimensions: {}, total: undefined };
  const dimensions = {};
  for (const dimension of DIMENSIONS) {
    const values = model.plans.map((plan) => planDimensionValue(plan, dimension));
    if (values.some((value) => value === undefined || isUnknownMarker(value))) continue;
    const finiteValues = values.filter((value) => !isUnboundedMarker(value));
    if (finiteValues.length === 0) {
      dimensions[dimension] = unboundedEntry("ALL_ENUMERATED_PLANS_UNBOUNDED");
      continue;
    }
    if (!finiteValues.every(finiteNonNegative)) continue;
    const minimum = Math.min(...finiteValues);
    const witness = values.findIndex((value) => value === minimum);
    dimensions[dimension] = exactEntry(dimension, minimum, {
      kind: "LEGAL_PLAN_ENUMERATION",
      planCount: model.plans.length,
      witnessPlan: witness
    });
  }

  const totals = model.plans.map((plan) => DIMENSIONS.map((dimension) => planDimensionValue(plan, dimension)));
  if (totals.every((values) => values.every(finiteNonNegative))) {
    const costs = totals.map((values) => values.reduce((sum, value) => sum + value, 0));
    const minimum = Math.min(...costs);
    const witness = costs.indexOf(minimum);
    return {
      dimensions,
      total: exactEntry("total", minimum, {
        kind: "LEGAL_PLAN_ENUMERATION",
        planCount: model.plans.length,
        witnessPlan: witness
      })
    };
  }
  return { dimensions, total: undefined };
}

function rawDimensionInput(input, dimension) {
  const lowerBounds = isObject(input.lowerBounds) ? input.lowerBounds[dimension] : undefined;
  const certified = isObject(input.certifiedLowerBounds) ? input.certifiedLowerBounds[dimension] : undefined;
  const direct = input[dimension];
  return { source: firstDefined(lowerBounds, certified, direct) };
}

function markedEntry(source, dimension) {
  if (isUnboundedMarker(source)) return unboundedEntry(`${dimension.toUpperCase()}_UNBOUNDED`);
  if (isUnknownMarker(source)) return unknownEntry(`${dimension.toUpperCase()}_UNKNOWN`);
  if (isObject(source) && (source.unbounded === true || source.bounded === false)) {
    return unboundedEntry(`${dimension.toUpperCase()}_UNBOUNDED`);
  }
  if (isObject(source) && (source.unknown === true || source.available === false)) {
    return unknownEntry(`${dimension.toUpperCase()}_UNKNOWN`);
  }
  return undefined;
}

function explicitLowerBound(source, dimension) {
  if (source === undefined) return undefined;
  if (finiteNonNegative(source)) {
    return lowerBoundEntry(dimension, source, { kind: "EXPLICIT_LOWER_BOUND" });
  }
  if (!isObject(source)) return undefined;
  const value = firstDefined(
    source.lowerBound,
    source.certifiedLowerBound,
    source.value,
    source.minimum
  );
  if (finiteNonNegative(value)) {
    return lowerBoundEntry(dimension, value, { kind: "EXPLICIT_LOWER_BOUND" });
  }
  return undefined;
}

function noWork(source, input, names) {
  const action = isObject(input.action) ? input.action : {};
  return [source, action, input].some((value) => isObject(value) && names.some((name) => value[name] === true));
}

function graphLowerBound(source, input) {
  if (noWork(source, input, ["noWork", "noGraphWork", "graphNotRequired"])) {
    return lowerBoundEntry("graph", 0, { kind: "NO_GRAPH_WORK_REQUIRED" });
  }
  if (!isObject(source)) return undefined;

  const affectedNodesValue = firstDefined(source.affectedNodeCount, source.affectedNodes, source.affectedSet);
  const affectedEdgesValue = firstDefined(source.affectedEdgeCount, source.affectedEdges);
  const directWork = firstDefined(source.affectedWork, source.requiredGraphWork, source.graphWork);
  if (finiteNonNegative(directWork)) {
    return lowerBoundEntry("graph", directWork, { kind: "AFFECTED_GRAPH_WORK" });
  }

  const nodeCount = countMaybe(affectedNodesValue, "graph.affectedNodes");
  const edgeCount = countMaybe(affectedEdgesValue, "graph.affectedEdges");
  if (nodeCount !== undefined) {
    const minimum = nodeCount + (edgeCount ?? 0);
    return lowerBoundEntry("graph", minimum, {
      kind: "AFFECTED_GRAPH_CLOSURE",
      affectedNodes: nodeCount,
      affectedEdges: edgeCount ?? 0,
      counting: "nodes-plus-edges"
    });
  }

  const graphNodes = source.nodes;
  const graphEdges = source.edges;
  const changedNodes = firstDefined(source.changedNodes, source.changed, input.changedNodes);
  if (Array.isArray(graphNodes) && Array.isArray(graphEdges) && changedNodes !== undefined) {
    const nodes = new Set(graphNodes);
    if (nodes.size !== graphNodes.length) throw new TypeError("graph nodes must be unique");
    if ([...nodes].some((node) => typeof node !== "string" || node.length === 0)) throw new TypeError("graph nodes must be non-empty strings");
    const dependents = new Map([...nodes].map((node) => [node, []]));
    for (const edge of graphEdges) {
      if (!isObject(edge) || typeof edge.from !== "string" || typeof edge.to !== "string") throw new TypeError("graph edges must contain from/to strings");
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) throw new RangeError("graph edge references an unknown node");
      dependents.get(edge.from).push(edge.to);
    }
    if (typeof changedNodes === "string" || changedNodes === null || typeof changedNodes[Symbol.iterator] !== "function") {
      throw new TypeError("graph.changedNodes must be iterable");
    }
    const changed = [...changedNodes];
    if (changed.some((node) => !nodes.has(node))) throw new RangeError("changed node is not in graph");
    const affected = new Set(changed);
    const queue = [...affected];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      for (const dependent of dependents.get(queue[cursor])) {
        if (affected.has(dependent)) continue;
        affected.add(dependent);
        queue.push(dependent);
      }
    }
    const edges = graphEdges.filter((edge) => affected.has(edge.from) && affected.has(edge.to)).length;
    return lowerBoundEntry("graph", affected.size + edges, {
      kind: "AFFECTED_GRAPH_CLOSURE",
      affectedNodes: affected.size,
      affectedEdges: edges,
      counting: "nodes-plus-edges"
    });
  }
  return undefined;
}

function externalLowerBound(source, input) {
  if (noWork(source, input, ["noWork", "noExternalWork", "externalNotRequired", "noExternalReadRequired"])) {
    return lowerBoundEntry("external", 0, { kind: "NO_EXTERNAL_WORK_REQUIRED" });
  }
  const action = isObject(input.action) ? input.action : {};
  const required = isObject(source) ? firstDefined(
    source.requiredExternalWork,
    source.requiredReads,
    source.requiredRequests,
    source.sourceReads,
    source.externalWork,
    source.required
  ) : undefined;
  const direct = firstDefined(required, input.requiredExternalReads, input.requiredSourceReads);
  if (finiteNonNegative(direct)) return lowerBoundEntry("external", direct, { kind: "REQUIRED_EXTERNAL_READS" });
  const sources = isObject(source) ? firstDefined(source.changedSources, source.requiredSources, source.sources) : undefined;
  const sourceCount = countMaybe(firstDefined(sources, input.changedSources), "external.sources");
  if (sourceCount !== undefined) return lowerBoundEntry("external", sourceCount, { kind: "REQUIRED_EXTERNAL_READS", sources: sourceCount });
  if (source?.requiresFreshSource === true || action.requiresFreshSource === true || input.requiresFreshSource === true) {
    return lowerBoundEntry("external", 1, { kind: "REQUIRED_EXTERNAL_READ" });
  }
  if (source?.requiresFreshSource === false || action.requiresFreshSource === false || input.requiresFreshSource === false) {
    return lowerBoundEntry("external", 0, { kind: "NO_EXTERNAL_WORK_REQUIRED" });
  }
  return undefined;
}

function validationLowerBound(source, input) {
  if (noWork(source, input, ["noWork", "noValidationWork", "validationNotRequired", "noValidationRequired"])) {
    return lowerBoundEntry("validation", 0, { kind: "NO_VALIDATION_REQUIRED" });
  }
  const action = isObject(input.action) ? input.action : {};
  const required = isObject(source) ? firstDefined(
    source.requiredValidations,
    source.validationCount,
    source.validations,
    source.required,
    source.requiredValidationWork
  ) : undefined;
  const direct = firstDefined(required, input.requiredValidations);
  if (finiteNonNegative(direct)) return lowerBoundEntry("validation", direct, { kind: "REQUIRED_VALIDATIONS" });
  const premises = isObject(source) ? firstDefined(source.criticalPremises, source.premises) : undefined;
  const premiseCount = countMaybe(firstDefined(premises, input.criticalPremises), "validation.criticalPremises");
  if (premiseCount !== undefined) return lowerBoundEntry("validation", premiseCount, { kind: "REQUIRED_VALIDATIONS", premises: premiseCount });
  if (source?.requiresValidation === true || action.requiresValidation === true || input.requiresValidation === true) {
    return lowerBoundEntry("validation", 1, { kind: "REQUIRED_VALIDATION" });
  }
  if (source?.requiresValidation === false || action.requiresValidation === false || input.requiresValidation === false) {
    return lowerBoundEntry("validation", 0, { kind: "NO_VALIDATION_REQUIRED" });
  }
  return undefined;
}

function writeLowerBound(source, input) {
  if (noWork(source, input, ["noWork", "noWriteWork", "writeNotRequired", "noWriteRequired"])) {
    return lowerBoundEntry("write", 0, { kind: "NO_WRITE_REQUIRED" });
  }
  const action = isObject(input.action) ? input.action : {};
  const required = isObject(source) ? firstDefined(
    source.requiredWrites,
    source.requiredAttempts,
    source.writeAttempts,
    source.writes,
    source.writeWork,
    source.required
  ) : undefined;
  const direct = firstDefined(required, input.requiredWrites, input.requiredWriteAttempts);
  if (finiteNonNegative(direct)) return lowerBoundEntry("write", direct, { kind: "REQUIRED_WRITE_ATTEMPTS" });
  if (source?.requiresWrite === true || source?.writeRequired === true || source?.write === true || source?.commitRequired === true
    || action.requiresWrite === true || action.commitRequired === true || input.requiresWrite === true || input.commitRequired === true) {
    return lowerBoundEntry("write", 1, { kind: "REQUIRED_WRITE_ATTEMPT" });
  }
  if (source?.requiresWrite === false || source?.writeRequired === false || source?.commitRequired === false
    || action.requiresWrite === false || action.commitRequired === false || input.requiresWrite === false || input.commitRequired === false) {
    return lowerBoundEntry("write", 0, { kind: "NO_WRITE_REQUIRED" });
  }
  return undefined;
}

function scalableEntry(input, dimension) {
  const { source } = rawDimensionInput(input, dimension);
  const marked = markedEntry(source, dimension);
  if (marked !== undefined) return marked;
  const explicitValue = explicitLowerBound(source, dimension);
  if (explicitValue !== undefined) return explicitValue;
  const lowerBound = dimension === "graph" ? graphLowerBound(source, input)
    : dimension === "external" ? externalLowerBound(source, input)
      : dimension === "validation" ? validationLowerBound(source, input)
        : writeLowerBound(source, input);
  return lowerBound ?? unknownEntry(`${dimension.toUpperCase()}_EVIDENCE_MISSING`);
}

function aggregateMode(entries) {
  if (entries.some((entry) => entry.mode === UNBOUNDED)) return UNBOUNDED;
  if (entries.some((entry) => entry.mode === UNKNOWN)) return UNKNOWN;
  if (entries.every((entry) => entry.mode === EXACT)) return EXACT;
  return CERTIFIED_LOWER_BOUND;
}

function totalEntry(entries, exactTotal) {
  if (exactTotal !== undefined) return exactTotal;
  if (entries.some((entry) => entry.mode === UNBOUNDED)) return unboundedEntry("DIMENSION_UNBOUNDED");
  if (entries.some((entry) => entry.mode === UNKNOWN)) return unknownEntry("DIMENSION_UNKNOWN");
  const minimum = entries.reduce((sum, entry) => sum + entry.minimum, 0);
  return lowerBoundEntry("total", minimum, { kind: "SUM_OF_DIMENSION_LOWER_BOUNDS" });
}

function resultFrom(entries, exactTotal) {
  const dimensions = freezeObject(Object.fromEntries(DIMENSIONS.map((dimension, index) => [dimension, entries[index]])));
  const total = totalEntry(entries, exactTotal);
  const minimum = freezeObject(Object.fromEntries([...DIMENSIONS, "total"].map((dimension) => [
    dimension,
    dimension === "total" ? total.minimum : dimensions[dimension].minimum
  ])));
  return freezeObject({
    format: ORACLE_FORMAT,
    mode: aggregateMode([...entries, total]),
    dimensions,
    total,
    minimum
  });
}

/**
 * Certify minimum work for the four v1 dimensions.
 *
 * `legalPlanModel` may contain a small complete `plans` iterable (or an
 * `enumerate()` function).  Otherwise the dimension-specific evidence is
 * interpreted only as a scalable lower bound.  A bare dimension number is
 * accepted as an explicit lower bound, never as an exact value.
 */
export function certifyMinimumWork(input = {}) {
  assertObject(input, "oracle input");
  const model = readPlanModel(input.legalPlanModel ?? input.legalPlans);
  const exact = exactFromPlans(model);
  const entries = DIMENSIONS.map((dimension) => exact.dimensions[dimension] ?? scalableEntry(input, dimension));
  return resultFrom(entries, exact.total);
}

export const minimumWork = certifyMinimumWork;
export const certifiedMinimumWork = certifyMinimumWork;

function oracleDimensions(oracle) {
  if (isObject(oracle?.dimensions)) return oracle.dimensions;
  if (isObject(oracle?.minimum)) return oracle.minimum;
  return oracle;
}

function actualDimensionValue(actual, dimension) {
  if (!isObject(actual)) return undefined;
  if (hasOwn(actual, dimension)) return unwrapValue(actual[dimension]);
  const work = isObject(actual.work) ? actual.work : isObject(actual.counters) ? actual.counters : actual;
  if (hasOwn(work, dimension)) return unwrapValue(work[dimension]);
  if (dimension === "graph") {
    const nodes = work.nodesVisited;
    const edges = work.edgesTraversed;
    if (finiteNonNegative(nodes) || finiteNonNegative(edges)) return (nodes ?? 0) + (edges ?? 0);
  }
  if (dimension === "external") return firstDefined(work.externalWork, work.sourceReads, work.requests);
  if (dimension === "validation") return firstDefined(work.validationWork, work.validations);
  if (dimension === "write") return firstDefined(work.writeWork, work.writeIntents, work.writeAttempts, work.CASAttempts);
  return undefined;
}

function denominatorEntry(oracle, dimension) {
  const dimensions = oracleDimensions(oracle);
  const source = dimensions?.[dimension];
  if (isObject(source) && hasOwn(source, "minimum")) return source;
  if (isObject(source) && (hasOwn(source, "value") || hasOwn(source, "lowerBound") || hasOwn(source, "certifiedLowerBound"))) return source;
  if (source === UNKNOWN) return { mode: UNKNOWN, minimum: UNKNOWN };
  if (source === UNBOUNDED) return { mode: UNBOUNDED, minimum: UNBOUNDED };
  if (finiteNonNegative(source)) return { mode: CERTIFIED_LOWER_BOUND, minimum: source };
  return undefined;
}

function amplification(actual, denominator) {
  const actualStatus = statusOf(actual);
  if (actualStatus === UNBOUNDED) return UNBOUNDED;
  if (actualStatus === UNKNOWN || actual === null || actual === undefined) return UNKNOWN;
  if (!finiteNonNegative(actual)) return UNKNOWN;
  const minimum = unwrapValue(denominator);
  const denominatorStatus = statusOf(denominator);
  if (denominatorStatus === UNBOUNDED || minimum === UNBOUNDED) return UNBOUNDED;
  if (denominatorStatus === UNKNOWN || minimum === UNKNOWN || !finitePositive(minimum)) return UNKNOWN;
  if (actual < minimum) return UNKNOWN;
  return actual / minimum;
}

/**
 * Return per-dimension and total work amplification.  Zero, UNKNOWN and
 * UNBOUNDED denominators are deliberately not coerced into a ratio.
 */
export function calculateWorkAmplification(actual = {}, oracle = {}) {
  const result = {};
  for (const dimension of DIMENSIONS) {
    result[dimension] = amplification(actualDimensionValue(actual, dimension), denominatorEntry(oracle, dimension));
  }
  const actualTotal = actualDimensionValue(actual, "total")
    ?? (DIMENSIONS.every((dimension) => finiteNonNegative(actualDimensionValue(actual, dimension)))
      ? DIMENSIONS.reduce((sum, dimension) => sum + actualDimensionValue(actual, dimension), 0)
      : UNKNOWN);
  result.total = amplification(actualTotal, denominatorEntry(oracle, "total") ?? oracle?.total);
  return freezeObject(result);
}

export const workAmplification = calculateWorkAmplification;
