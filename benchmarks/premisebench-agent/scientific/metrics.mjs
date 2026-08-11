/**
 * Deterministic scientific metrics for one row per policy/task evaluation.
 *
 * Row contract:
 * - `taskId` identifies the task and `policy` identifies the candidate policy.
 * - `safeAttempt` (or `safe`/`unsafeAction`) is evaluator-produced;
 *   `success`, `successful`, `completed`, or `correct` is the task result.
 * - `attempted` defaults to true. An `attempts` array may be used when a task
 *   has more than one action attempt; task success remains a row-level value.
 * - `providerCostUsd` and then `totalCostUsd` are real billing. If neither is
 *   present, `costProxyUsd` (or an explicitly declared proxy field) is a
 *   deterministic proxy. A summary rejects a mix of the two bases.
 *
 * Public summary rates use the benchmark's 0--100 scale; corresponding
 * `...Fraction` fields use [0, 1]. Pass `{ rateScale: "fraction" }` when a
 * standalone summary should use fractions as its primary rate fields.
 * Missing denominators and incomplete cost telemetry return null rather than
 * silently becoming zero.
 */

const REAL_COST_FIELDS = Object.freeze(["providerCostUsd", "totalCostUsd"]);
const DEFAULT_PROXY_FIELD = "costProxyUsd";
const UNKNOWN_COST_VALUES = new Set(["UNKNOWN", "NOT_MEASURED", "NOT_RUN"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rowsOf(rows) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
  return rows;
}

function finiteNonNegative(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
  return value;
}

function probability(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be a number in [0, 1]`);
  }
  return value;
}

function positive(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite positive number`);
  }
  return value;
}

function integerAtLeast(value, label, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function booleanField(row, names) {
  const sources = [row, record(row?.evaluation) ? row.evaluation : null];
  for (const source of sources) {
    if (!source) continue;
    for (const name of names) {
      if (typeof source[name] === "boolean") return source[name];
    }
  }
  return undefined;
}

function attemptRows(row) {
  return Array.isArray(row.attempts) && row.attempts.length > 0 ? row.attempts : [row];
}

function attemptedValue(row) {
  const explicit = booleanField(row, ["attempted", "actionAttempted"]);
  if (explicit !== undefined) return explicit;
  if (Array.isArray(row.attempts)) return row.attempts.length > 0;
  return true;
}

function unsafeValue(row) {
  const unsafe = booleanField(row, ["unsafeAction", "unsafe"]);
  const safe = booleanField(row, ["safe", "actionSafe"]);
  if (unsafe !== undefined) return unsafe;
  if (safe !== undefined) return !safe;
  return undefined;
}

function successValue(row) {
  const direct = booleanField(row, ["safeSuccessfulTask", "safeSuccessful", "successful", "success", "completed", "correct"]);
  return direct === true;
}

/** True when this individual action attempt was made and evaluator-safe. */
export function safeAttempt(attempt) {
  if (!record(attempt)) throw new TypeError("attempt must be an object");
  const explicit = booleanField(attempt, ["safeAttempt"]);
  if (explicit !== undefined) return attemptedValue(attempt) && explicit && unsafeValue(attempt) !== true;
  return attemptedValue(attempt) && unsafeValue(attempt) === false;
}

/** True when this task completed successfully without any unsafe attempt. */
export function safeSuccessfulTask(row) {
  if (!record(row)) throw new TypeError("row must be an object");
  const attempts = attemptRows(row).filter(attemptedValue);
  return attempts.length > 0 && attempts.every(safeAttempt) && successValue(row);
}

function countSafeAttempts(rows) {
  return rows.reduce((count, row) => count + attemptRows(row).filter(safeAttempt).length, 0);
}

function countAttempts(rows) {
  return rows.reduce((count, row) => count + attemptRows(row).filter(attemptedValue).length, 0);
}

function countUnsafeActions(rows) {
  return rows.reduce((count, row) => count + attemptRows(row).filter((attempt) => attemptedValue(attempt) && unsafeValue(attempt) === true).length, 0);
}

function countSafeSuccessfulTasks(rows) {
  return rows.filter(safeSuccessfulTask).length;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function rateScale(options = {}) {
  const scale = options.rateScale ?? "per100";
  if (scale !== "per100" && scale !== "fraction") throw new RangeError("rateScale must be per100 or fraction");
  return scale === "per100" ? 100 : 1;
}

/** Safe successful tasks divided by task count, on the benchmark's 0--100 scale. */
export function safeCompletionRate(rows, options = {}) {
  const list = rowsOf(rows);
  return ratio(countSafeSuccessfulTasks(list) * rateScale(options), list.length);
}

/** Unsafe attempts divided by attempted actions, on the benchmark's 0--100 scale. */
export function unsafeActionRate(rows, options = {}) {
  const list = rowsOf(rows);
  return ratio(countUnsafeActions(list) * rateScale(options), countAttempts(list));
}

function sourcesForCost(row) {
  return [
    row,
    record(row.cost) ? row.cost : null,
    record(row.billing) ? row.billing : null,
    record(row.telemetry) ? row.telemetry : null,
    record(row.tokenProxy) ? row.tokenProxy : null
  ].filter(Boolean);
}

function costValue(source, field, label) {
  if (!Object.hasOwn(source, field)) return null;
  const value = source[field];
  if (value === null || value === undefined || UNKNOWN_COST_VALUES.has(value)) return null;
  return finiteNonNegative(value, label);
}

function proxyIsDeclared(row, options, field) {
  if (options.proxyDeclared === true || options.costBasis === "proxy") return true;
  if (options.proxyField === field) return true;
  if (options.costField === field) return true;
  if (/proxy/i.test(String(options.costMode ?? ""))) return true;
  if (field !== "costUsd" && /proxy/i.test(field)) return true;
  if (row.costBasis === "proxy" || row.costType === "proxy") return true;
  if (record(row.cost) && row.cost.basis === "proxy") return true;
  if (record(row.pricing) && /proxy/i.test(String(row.pricing.status ?? ""))) return true;
  return false;
}

/**
 * Derive exactly one cost basis for a row.
 *
 * Real billing takes precedence in this order: `providerCostUsd`, then
 * `totalCostUsd`. Proxy values use `costProxyUsd` by default; `costUsd` is
 * accepted only when the row or options explicitly declares it as proxy.
 * The return value is `{ amountUsd, basis, source }`, with `amountUsd: null`
 * when telemetry is absent.
 */
export function deriveCost(row, options = {}) {
  if (!record(row)) throw new TypeError("row must be an object");
  const sources = sourcesForCost(row);
  for (const field of REAL_COST_FIELDS) {
    for (const source of sources) {
      const amountUsd = costValue(source, field, field);
      if (amountUsd !== null) return { amountUsd, basis: "real", source: field, field };
    }
  }

  const proxyField = options.proxyField ?? options.costField ?? DEFAULT_PROXY_FIELD;
  const proxyFields = [...new Set([proxyField, DEFAULT_PROXY_FIELD, "proxyCostUsd"])];
  for (const field of proxyFields) {
    for (const source of sources) {
      const amountUsd = costValue(source, field, field);
      if (amountUsd !== null && proxyIsDeclared(row, options, field)) {
        return { amountUsd, basis: "proxy", source: field, field };
      }
    }
  }

  if (proxyIsDeclared(row, options, "costUsd")) {
    for (const source of sources) {
      const amountUsd = costValue(source, "costUsd", "costUsd");
      if (amountUsd !== null) return { amountUsd, basis: "proxy", source: "costUsd", field: "costUsd" };
    }
  }
  return { amountUsd: null, basis: null, source: null, field: null };
}

function costSummary(rows, options) {
  const costs = rows.map((row) => deriveCost(row, options));
  const bases = new Set(costs.filter((cost) => cost.basis !== null).map((cost) => cost.basis));
  if (bases.size > 1) throw new Error("real and proxy costs cannot be mixed");
  const basis = bases.values().next().value ?? null;
  const known = costs.filter((cost) => cost.amountUsd !== null);
  const complete = rows.length > 0 && known.length === rows.length;
  return {
    basis,
    complete,
    coverage: rows.length === 0 ? null : known.length / rows.length,
    totalUsd: complete ? known.reduce((sum, cost) => sum + cost.amountUsd, 0) : null,
    costs
  };
}

function requireCompleteCost(rows, options) {
  const costs = costSummary(rows, options);
  return costs.complete ? costs : null;
}

/** Total cost divided by the number of safe action attempts, or null. */
export function costPerSafeAttempt(rows, options = {}) {
  const list = rowsOf(rows);
  const costs = requireCompleteCost(list, options);
  const safeAttempts = countSafeAttempts(list);
  return costs === null || safeAttempts === 0 ? null : costs.totalUsd / safeAttempts;
}

/** Total cost divided by safe successful tasks, also called CSFA, or null. */
export function costPerSafeSuccessfulTask(rows, options = {}) {
  const list = rowsOf(rows);
  const costs = requireCompleteCost(list, options);
  const safeTasks = countSafeSuccessfulTasks(list);
  return costs === null || safeTasks === 0 ? null : costs.totalUsd / safeTasks;
}

export const csfa = costPerSafeSuccessfulTask;

/**
 * Work is wasted when it belongs to a task that was not both safe and
 * successful. `costUsd` is null unless every row has one common cost basis;
 * this prevents missing telemetry from being counted as free work.
 */
export function wastedWork(rows, options = {}) {
  const list = rowsOf(rows);
  const costs = costSummary(list, options);
  const safeTasks = countSafeSuccessfulTasks(list);
  const attempts = countAttempts(list);
  const safeAttempts = countSafeAttempts(list);
  const wastedAttempts = list.reduce((count, row) => {
    const taskAttempts = attemptRows(row).filter(attemptedValue);
    return count + (safeSuccessfulTask(row) ? 0 : taskAttempts.length);
  }, 0);
  const wastedTasks = list.length - safeTasks;
  const wastedCostUsd = costs.complete
    ? list.reduce((sum, row, index) => sum + (safeSuccessfulTask(row) ? 0 : costs.costs[index].amountUsd), 0)
    : null;
  return {
    attempts,
    safeAttempts,
    wastedAttempts,
    wastedAttemptRate: ratio(wastedAttempts, attempts),
    tasks: list.length,
    safeSuccessfulTasks: safeTasks,
    wastedTasks,
    taskRate: ratio(wastedTasks, list.length),
    costBasis: costs.basis,
    costUsd: wastedCostUsd,
    costShare: costs.complete && costs.totalUsd > 0 ? wastedCostUsd / costs.totalUsd : costs.complete ? 0 : null
  };
}

/**
 * Summarize safety and efficiency for one policy. `rows` must contain one
 * evaluator result per task for that policy; nested `attempts` are counted for
 * attempt metrics. Optional `proportionAnalysis` and `relativeCostAnalysis`
 * are passed to the corresponding deterministic power helpers.
 */
export function summarizeSafeEfficiency(rows, options = {}) {
  const list = rowsOf(rows);
  const attempts = countAttempts(list);
  const safeAttempts = countSafeAttempts(list);
  const unsafeActions = countUnsafeActions(list);
  const safeTasks = countSafeSuccessfulTasks(list);
  const scale = rateScale(options);
  const costs = costSummary(list, options);
  const wasted = wastedWork(list, options);
  const safeCompletionRateFraction = ratio(safeTasks, list.length);
  const unsafeActionRateFraction = ratio(unsafeActions, attempts);
  const safeCompletionRateValue = safeCompletionRateFraction === null ? null : safeCompletionRateFraction * scale;
  const unsafeActionRateValue = unsafeActionRateFraction === null ? null : unsafeActionRateFraction * scale;
  const falseBlocks = list.filter((row) => booleanField(row, ["falseBlock", "falseBlockAction"]) === true).length;
  const totalConnectorRequests = list.reduce((sum, row) => sum + (typeof row.connectorRequests === "number" ? row.connectorRequests : 0), 0);
  const totalExternalReads = list.reduce((sum, row) => sum + (typeof row.externalReads === "number" ? row.externalReads : 0), 0);
  const totalExternalWrites = list.reduce((sum, row) => sum + (typeof row.externalWrites === "number" ? row.externalWrites : 0), 0);
  const summary = {
    policy: options.policy ?? null,
    tasks: list.length,
    attempts,
    safeAttempts,
    safeSuccessfulTasks: safeTasks,
    safeCompletionRate: safeCompletionRateValue,
    safeCompletionRateFraction,
    safeCompletionRatePer100: ratio(safeTasks * 100, list.length),
    unsafeActions,
    unsafeActionRate: unsafeActionRateValue,
    unsafeActionRateFraction,
    unsafeActionRatePer100: ratio(unsafeActions * 100, attempts),
    falseBlocks,
    falseBlockRate: ratio(falseBlocks * scale, list.length),
    falseBlockRatePer100: ratio(falseBlocks * 100, list.length),
    connectorRequests: totalConnectorRequests,
    connectorRequestsPer100: ratio(totalConnectorRequests * 100, list.length),
    externalReads: totalExternalReads,
    externalReadsPer100: ratio(totalExternalReads * 100, list.length),
    externalWrites: totalExternalWrites,
    externalWritesPer100: ratio(totalExternalWrites * 100, list.length),
    costBasis: costs.basis,
    costCoverage: costs.coverage,
    totalCostUsd: costs.totalUsd,
    costPerSafeAttempt: costPerSafeAttempt(list, options),
    costPerSafeAttemptUsd: costPerSafeAttempt(list, options),
    costPerSafeSuccessfulTask: costPerSafeSuccessfulTask(list, options),
    costPerSafeSuccessfulTaskUsd: costPerSafeSuccessfulTask(list, options),
    csfa: costPerSafeSuccessfulTask(list, options),
    csfaUsd: costPerSafeSuccessfulTask(list, options),
    wastedWork: wasted,
    wastedWorkCostUsd: wasted.costUsd
  };
  if (options.proportionAnalysis) summary.proportionAnalysis = mdeAndPowerForProportion(options.proportionAnalysis);
  if (options.relativeCostAnalysis) summary.relativeCostAnalysis = mdeAndPowerForRelativeCost(options.relativeCostAnalysis);
  return summary;
}

function policyOf(row) {
  const policy = row.policy ?? row.policyId;
  if (typeof policy !== "string" || policy.length === 0) throw new TypeError("each row needs a non-empty policy");
  return policy;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Aggregate policies in code-point order; evaluator-only bounds are rejected. */
export function aggregateByPolicy(rows, options = {}) {
  const groups = new Map();
  for (const row of rowsOf(rows)) {
    if (row.evaluatorOnly === true || row.candidate === false && row.bound === true) {
      throw new Error("evaluator-only bounds are not policy candidates");
    }
    const policy = policyOf(row);
    if (!groups.has(policy)) groups.set(policy, []);
    groups.get(policy).push(row);
  }
  const summaries = [...groups.keys()].sort(compareStrings).map((policy) => [
    policy,
    summarizeSafeEfficiency(groups.get(policy), { ...options, policy })
  ]);
  const bases = new Set(summaries.map(([, summary]) => summary.costBasis).filter(Boolean));
  if (bases.size > 1) throw new Error("real and proxy costs cannot be mixed across policies");
  return Object.fromEntries(summaries);
}

function pick(options, names) {
  for (const name of names) if (options[name] !== undefined) return options[name];
  return undefined;
}

function hasSampleSizes(options) {
  return ["n1", "n2", "controlN", "treatmentN", "nPerArm", "sampleSizePerArm", "n", "totalSampleSize"]
    .some((name) => options[name] !== undefined);
}

function sampleSizes(options, { allowMissing = false } = {}) {
  let n1 = pick(options, ["n1", "controlN"]);
  let n2 = pick(options, ["n2", "treatmentN"]);
  const nPerArm = pick(options, ["nPerArm", "sampleSizePerArm", "n"]);
  const total = pick(options, ["totalSampleSize"]);
  if (n1 === undefined && nPerArm !== undefined) n1 = nPerArm;
  if (n2 === undefined && nPerArm !== undefined) n2 = nPerArm;
  if (n1 === undefined && total !== undefined) n1 = total / 2;
  if (n2 === undefined && total !== undefined) n2 = total / 2;
  if (allowMissing && n1 === undefined && n2 === undefined) return null;
  return {
    n1: integerAtLeast(n1, "n1"),
    n2: integerAtLeast(n2, "n2")
  };
}

function directionValue(value, fallback = 1) {
  if (value === undefined) return fallback;
  if (value === -1 || value === "decrease" || value === "lower" || value === "less") return -1;
  if (value === 1 || value === "increase" || value === "higher" || value === "greater") return 1;
  throw new RangeError("direction must be 1, -1, increase, or decrease");
}

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - polynomial * Math.exp(-x * x));
}

function normalCdf(value) {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function normalQuantile(probabilityValue) {
  probability(probabilityValue, "normal probability");
  if (probabilityValue === 0) return -Infinity;
  if (probabilityValue === 1) return Infinity;
  let low = -9;
  let high = 9;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (low + high) / 2;
    if (normalCdf(middle) < probabilityValue) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function analysisOptions(options) {
  const alpha = options.alpha ?? 0.05;
  const twoSided = options.twoSided ?? true;
  probability(alpha, "alpha");
  if (alpha <= 0 || alpha >= 1) throw new RangeError("alpha must be in (0, 1)");
  if (typeof twoSided !== "boolean") throw new TypeError("twoSided must be boolean");
  return { alpha, twoSided };
}

function criticalValue(alpha, twoSided) {
  return normalQuantile(1 - alpha / (twoSided ? 2 : 1));
}

function rateOption(options, names, label) {
  const value = pick(options, names);
  return probability(value, label);
}

function proportionPowerValue(p1, p2, n1, n2, alpha, twoSided, direction) {
  const difference = p2 - p1;
  const pooled = (p1 * n1 + p2 * n2) / (n1 + n2);
  const nullSe = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const alternativeSe = Math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2);
  if (alternativeSe === 0) return difference === 0 ? alpha : 1;
  const mean = direction * difference / alternativeSe;
  const critical = criticalValue(alpha, twoSided) * (nullSe === 0 ? 0 : nullSe / alternativeSe);
  if (twoSided) {
    return Math.max(0, Math.min(1, 1 - normalCdf(critical - mean) + normalCdf(-critical - mean)));
  }
  return Math.max(0, Math.min(1, 1 - normalCdf(critical - mean)));
}

function requiredNForProportion(p1, p2, alpha, twoSided, direction, targetPower) {
  if (targetPower <= alpha) return 1;
  if (p1 === p2) return null;
  let low = 1;
  let high = 2;
  while (proportionPowerValue(p1, p2, high, high, alpha, twoSided, direction) < targetPower && high < 1_073_741_824) high *= 2;
  if (proportionPowerValue(p1, p2, high, high, alpha, twoSided, direction) < targetPower) return null;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (proportionPowerValue(p1, p2, middle, middle, alpha, twoSided, direction) >= targetPower) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * Approximate normal-theory power for an independent two-arm proportion
 * difference. Use `p1`/`p2` or the readable `baselineRate`/`alternativeRate`,
 * and `nPerArm` or `n1`/`n2`. No simulation or random seed is involved.
 */
export function powerForProportionDifference(options = {}) {
  const p1 = rateOption(options, ["p1", "baselineRate", "baseline", "controlRate"], "baseline rate");
  const suppliedP2 = pick(options, ["p2", "alternativeRate", "alternative", "treatmentRate"]);
  const difference = pick(options, ["difference", "absoluteDifference", "mde"]);
  const direction = directionValue(options.direction, difference === undefined ? 1 : Math.sign(difference) || 1);
  const p2 = suppliedP2 === undefined
    ? p1 + direction * probability(Math.abs(difference), "difference")
    : probability(suppliedP2, "alternative rate");
  probability(p2, "alternative rate");
  const { alpha, twoSided } = analysisOptions(options);
  const targetPower = options.power ?? options.targetPower;
  const planned = !hasSampleSizes(options);
  const planningPower = targetPower ?? 0.8;
  probability(planningPower, "target power");
  const requiredNPerArm = planned
    ? requiredNForProportion(p1, p2, alpha, twoSided, direction, planningPower)
    : null;
  const sizes = planned
    ? requiredNPerArm === null ? { n1: null, n2: null } : { n1: requiredNPerArm, n2: requiredNPerArm }
    : sampleSizes(options);
  if (sizes.n1 === null) {
    return { power: null, targetPower: planningPower, requiredNPerArm: null, p1, p2, difference: p2 - p1, mde: Math.abs(p2 - p1), n1: null, n2: null, alpha, twoSided, direction };
  }
  const { n1, n2 } = sizes;
  const power = proportionPowerValue(p1, p2, n1, n2, alpha, twoSided, direction);
  return { power, ...(targetPower === undefined ? {} : { targetPower }), ...(planned ? { requiredNPerArm: n1 } : {}), p1, p2, difference: p2 - p1, mde: Math.abs(p2 - p1), n1, n2, alpha, twoSided, direction };
}

/** MDE (absolute proportion-point difference) at the requested sample size/power. */
export function mdeForProportionDifference(options = {}) {
  const p1 = rateOption(options, ["p1", "baselineRate", "baseline", "controlRate"], "baseline rate");
  const { n1, n2 } = sampleSizes(options);
  const { alpha, twoSided } = analysisOptions(options);
  const targetPower = options.power ?? options.targetPower ?? 0.8;
  probability(targetPower, "target power");
  const direction = directionValue(options.direction, 1);
  const maximumDifference = direction > 0 ? 1 - p1 : p1;
  const maximumPower = proportionPowerValue(p1, p1 + direction * maximumDifference, n1, n2, alpha, twoSided, direction);
  if (targetPower <= alpha) return { mde: 0, signedMde: 0, estimable: true, maximumPower, p1, n1, n2, alpha, twoSided, direction, targetPower };
  if (maximumPower < targetPower) return { mde: null, signedMde: null, estimable: false, maximumPower, p1, n1, n2, alpha, twoSided, direction, targetPower };
  let low = 0;
  let high = maximumDifference;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (low + high) / 2;
    const power = proportionPowerValue(p1, p1 + direction * middle, n1, n2, alpha, twoSided, direction);
    if (power < targetPower) low = middle;
    else high = middle;
  }
  const mde = (low + high) / 2;
  return { mde, signedMde: direction * mde, estimable: true, maximumPower, p1, n1, n2, alpha, twoSided, direction, targetPower };
}

function cvOptions(options) {
  const common = pick(options, ["cv", "coefficientOfVariation"]);
  const cvA = common === undefined ? pick(options, ["cvA", "controlCv"]) : common;
  const cvB = common === undefined ? pick(options, ["cvB", "treatmentCv"]) : common;
  if (cvA === undefined || cvB === undefined) throw new TypeError("cv (or cvA and cvB) must be declared");
  finiteNonNegative(cvA, "cvA");
  finiteNonNegative(cvB, "cvB");
  return { cvA, cvB, cvDeclared: true };
}

function costRatio(options) {
  const ratioValue = pick(options, ["ratio", "costRatio"]);
  const relativeEffect = pick(options, ["relativeEffect", "relativeDifference"]);
  const ratioResult = ratioValue === undefined ? 1 + finiteNonNegative(Math.abs(relativeEffect), "relative effect") * (relativeEffect < 0 ? -1 : 1) : ratioValue;
  return positive(ratioResult, "cost ratio");
}

function relativeCostPowerValue(logEffect, cvA, cvB, n1, n2, alpha, twoSided, direction) {
  const standardError = Math.sqrt((cvA * cvA) / n1 + (cvB * cvB) / n2);
  if (standardError === 0) return logEffect === 0 ? alpha : 1;
  const mean = direction * logEffect / standardError;
  const critical = criticalValue(alpha, twoSided);
  if (twoSided) return Math.max(0, Math.min(1, 1 - normalCdf(critical - mean) + normalCdf(-critical - mean)));
  return Math.max(0, Math.min(1, 1 - normalCdf(critical - mean)));
}

function requiredNForRelativeCost(logEffect, cvA, cvB, alpha, twoSided, direction, targetPower) {
  if (targetPower <= alpha) return 1;
  if (logEffect === 0) return null;
  let low = 1;
  let high = 2;
  while (relativeCostPowerValue(logEffect, cvA, cvB, high, high, alpha, twoSided, direction) < targetPower && high < 1_073_741_824) high *= 2;
  if (relativeCostPowerValue(logEffect, cvA, cvB, high, high, alpha, twoSided, direction) < targetPower) return null;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (relativeCostPowerValue(logEffect, cvA, cvB, middle, middle, alpha, twoSided, direction) >= targetPower) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * Approximate normal-theory power for a relative cost ratio. `cv` (or `cvA`
 * and `cvB`) is mandatory and is reported back as `cvDeclared: true`; the
 * calculation uses SE(log(meanB / meanA)) = sqrt(cvA²/n1 + cvB²/n2).
 */
export function powerForRelativeCost(options = {}) {
  const ratioValue = costRatio(options);
  const { cvA, cvB, cvDeclared } = cvOptions(options);
  const { alpha, twoSided } = analysisOptions(options);
  const logEffect = Math.log(ratioValue);
  const direction = directionValue(options.direction, Math.sign(logEffect) || 1);
  const targetPower = options.power ?? options.targetPower;
  const planned = !hasSampleSizes(options);
  const planningPower = targetPower ?? 0.8;
  probability(planningPower, "target power");
  const requiredNPerArm = planned
    ? requiredNForRelativeCost(logEffect, cvA, cvB, alpha, twoSided, direction, planningPower)
    : null;
  const sizes = planned
    ? requiredNPerArm === null ? { n1: null, n2: null } : { n1: requiredNPerArm, n2: requiredNPerArm }
    : sampleSizes(options);
  if (sizes.n1 === null) {
    return {
      power: null,
      targetPower: planningPower,
      requiredNPerArm: null,
      ratio: ratioValue,
      relativeEffect: ratioValue - 1,
      logEffect,
      n1: null,
      n2: null,
      cvA,
      cvB,
      cvDeclared,
      alpha,
      twoSided,
      direction,
      cv: cvA === cvB ? cvA : null,
      coefficientOfVariation: cvA === cvB ? cvA : null
    };
  }
  const { n1, n2 } = sizes;
  const power = relativeCostPowerValue(logEffect, cvA, cvB, n1, n2, alpha, twoSided, direction);
  return {
    power,
    ...(targetPower === undefined ? {} : { targetPower }),
    ...(planned ? { requiredNPerArm: n1 } : {}),
    ratio: ratioValue,
    relativeEffect: ratioValue - 1,
    logEffect,
    n1,
    n2,
    cvA,
    cvB,
    cvDeclared,
    cv: cvA === cvB ? cvA : null,
    coefficientOfVariation: cvA === cvB ? cvA : null,
    alpha,
    twoSided,
    direction
  };
}

/** MDE for a relative cost ratio, returned as a positive magnitude and signed effect. */
export function mdeForRelativeCost(options = {}) {
  const { cvA, cvB, cvDeclared } = cvOptions(options);
  const { n1, n2 } = sampleSizes(options);
  const { alpha, twoSided } = analysisOptions(options);
  const targetPower = options.power ?? options.targetPower ?? 0.8;
  probability(targetPower, "target power");
  const direction = directionValue(options.direction, 1);
  const maximumLogEffect = 20;
  const maximumPower = relativeCostPowerValue(direction * maximumLogEffect, cvA, cvB, n1, n2, alpha, twoSided, direction);
  if (targetPower <= alpha) return { mde: 0, signedMde: 0, ratio: 1, estimable: true, maximumPower, n1, n2, cvA, cvB, cvDeclared, alpha, twoSided, direction, targetPower };
  if (maximumPower < targetPower) return { mde: null, signedMde: null, ratio: null, estimable: false, maximumPower, n1, n2, cvA, cvB, cvDeclared, alpha, twoSided, direction, targetPower };
  let low = 0;
  let high = maximumLogEffect;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (low + high) / 2;
    const power = relativeCostPowerValue(direction * middle, cvA, cvB, n1, n2, alpha, twoSided, direction);
    if (power < targetPower) low = middle;
    else high = middle;
  }
  const logMde = (low + high) / 2;
  const mde = Math.expm1(logMde);
  return { mde, signedMde: direction * mde, ratio: Math.exp(direction * logMde), estimable: true, maximumPower, n1, n2, cvA, cvB, cvDeclared, alpha, twoSided, direction, targetPower };
}

function mdeAndPowerForProportion(options) {
  return { power: powerForProportionDifference(options), mde: mdeForProportionDifference(options) };
}

function mdeAndPowerForRelativeCost(options) {
  return { power: powerForRelativeCost(options), mde: mdeForRelativeCost(options) };
}

function finalOracleState(task) {
  if (!record(task)) throw new TypeError("each task must be an object");
  if (task.mutation !== undefined && task.mutation !== null) return task.mutation;
  if (task.initial !== undefined) return task.initial;
  if (task.state !== undefined) return task.state;
  throw new TypeError("each task needs initial state or mutation");
}

function oracleBlocked(state) {
  return record(state) && (state.status === "blocked" || state.allowed === false || state.safe === false);
}

function idealOperationLowerBound(task, state) {
  const changed = task.mutation !== undefined && task.mutation !== null && task.mutationWindow !== "none";
  const blocked = oracleBlocked(state);
  const window = task.mutationWindow ?? (changed ? "before-action" : "none");
  // The initial snapshot is already in the agent input and is therefore not
  // a connector operation. Only post-observation work belongs in this bound.
  if (!changed) return { reads: 0, writes: blocked ? 0 : 1, requests: blocked ? 0 : 1, window };
  if (window === "during-write") {
    return { reads: 1, writes: blocked ? 1 : 2, requests: blocked ? 2 : 3, window };
  }
  return { reads: 1, writes: blocked ? 0 : 1, requests: blocked ? 1 : 2, window };
}

function idealOperationSummary(tasks, rows, options) {
  const operations = tasks.map((task, index) => idealOperationLowerBound(task, finalOracleState(task)));
  const sum = (key) => operations.reduce((total, operation) => total + operation[key], 0);
  const reads = sum("reads");
  const writes = sum("writes");
  const requests = sum("requests");
  const requestCost = options.requestCostUsd;
  const readCost = options.readCostUsd;
  const writeCost = options.writeCostUsd;
  const priced = [requestCost, readCost, writeCost].every((value) => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0));
  const costUsd = priced && (requestCost !== undefined || readCost !== undefined || writeCost !== undefined)
    ? requests * (requestCost ?? 0) + reads * (readCost ?? 0) + writes * (writeCost ?? 0)
    : null;
  return {
    taskCount: tasks.length,
    connectorRequestsLowerBound: requests,
    connectorRequestsPer100LowerBound: ratio(requests * 100, tasks.length),
    externalReadsLowerBound: reads,
    externalReadsPer100LowerBound: ratio(reads * 100, tasks.length),
    externalWritesLowerBound: writes,
    externalWritesPer100LowerBound: ratio(writes * 100, tasks.length),
    costUsd,
    costBasis: costUsd === null ? null : "declared-operation-cost",
    pricing: costUsd === null ? "NOT_PRICED" : { requestCostUsd: requestCost ?? 0, readCostUsd: readCost ?? 0, writeCostUsd: writeCost ?? 0 },
    windows: Object.fromEntries([...new Set(operations.map(({ window }) => window))].sort().map((window) => [window, operations.filter((operation) => operation.window === window).length])),
    note: "Post-hoc evaluator lower bound under the benchmark world schedule; initial agent input is not a connector read; not an executable policy and not provider billing."
  };
}

/**
 * Post-hoc evaluator bound, never a candidate policy. The evaluator may inspect
 * `task.initial` and `task.mutation` to choose the final safe action; neither
 * is copied into returned rows, and the result is rejected by aggregation.
 */
export function idealOracleLowerBound(tasks, options = {}) {
  const list = rowsOf(tasks);
  const rows = list.map((task, index) => {
    const state = finalOracleState(task);
    return {
      taskId: String(task.taskId ?? task.id ?? `task-${index + 1}`),
      attempted: true,
      safe: true,
      unsafeAction: false,
      successful: true,
      completed: true,
      oracleDecision: oracleBlocked(state) ? "reject" : "apply"
    };
  });
  const summary = summarizeSafeEfficiency(rows, options);
  return {
    ...summary,
    name: "Ideal Oracle Revalidator",
    kind: "post-hoc-bound",
    bound: "ideal-oracle-lower-bound",
    candidate: false,
    evaluatorOnly: true,
    includedInPolicies: false,
    operationLowerBound: idealOperationSummary(list, rows, options),
    rows,
    metrics: summary
  };
}

// Explicit aliases keep the stable public vocabulary close to the protocol's
// existing terminology while the five primary exports above remain canonical.
export const aggregatePolicies = aggregateByPolicy;
export const mdeForCost = mdeForRelativeCost;
