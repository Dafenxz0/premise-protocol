function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function percentile(values, probability) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!finite(probability) || probability < 0 || probability > 1) throw new RangeError("probability must be between 0 and 1");
  if (!values.every(finite)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1));
  return sorted[index];
}

export function ratio(numerator, denominator) {
  return finite(numerator) && finite(denominator) && denominator > 0 ? numerator / denominator : null;
}

export function percent(numerator, denominator) {
  const result = ratio(numerator, denominator);
  return result === null ? null : result * 100;
}

export function workAmplification(performed, minimum) {
  return ratio(performed, minimum);
}

export function aggregateCandidateResults(records) {
  if (!Array.isArray(records) || records.length === 0) throw new RangeError("records must not be empty");
  const sum = (field) => records.every((record) => finite(record[field]))
    ? records.reduce((total, record) => total + record[field], 0)
    : null;
  const sumKnown = (values) => values.every(finite) ? values.reduce((total, value) => total + value, 0) : null;
  const durations = records.map((record) => record.latencyMs);
  const tasks = records.length;
  const unsafeActions = sum("unsafeActions");
  const safeCompletions = sum("safeCompletions");
  const completed = sum("completed");
  const reads = sum("sourceReads");
  const externalWork = sum("externalWork");
  const graphWork = sum("graphWork");
  const protocolWork = sum("protocolWork");
  // Requests include reads and writes. Signals, validation, graph and protocol
  // work remain separate so no policy gets them for free.
  const totalWork = sumKnown([sum("requests"), sum("eventSignals"), sum("validations"), graphWork, protocolWork]);
  return Object.freeze({
    tasks,
    completed,
    safeCompletions,
    safeCompletionRate: percent(safeCompletions, tasks),
    unsafeActions,
    unsafeActionRate: percent(unsafeActions, tasks),
    toctouEscapes: sum("toctouEscapes"),
    crossTenantReuse: sum("crossTenantReuse"),
    sourceReads: reads,
    writes: sum("writes"),
    readsPerSafeCompletion: ratio(reads, safeCompletions),
    requests: sum("requests"),
    requestsPerSafeCompletion: ratio(sum("requests"), safeCompletions),
    eventSignals: sum("eventSignals"),
    validations: sum("validations"),
    reusedReceipts: sum("reuse"),
    batchedOperations: sum("batching"),
    incrementalOperations: sum("incrementality"),
    evaluatedNodes: sum("nodes"),
    evaluatedEdges: sum("edges"),
    dependencyTraversals: sum("dependencies"),
    invalidations: sum("invalidations"),
    externalWork,
    graphWork,
    protocolWork,
    totalWork,
    workPerSafeCompletion: ratio(totalWork, safeCompletions),
    workAmplification: workAmplification(totalWork, sum("minimumWork")),
    staleDetections: sum("staleDetections"),
    staleRecoveries: sum("staleRecoveries"),
    staleDetectionRate: percent(sum("staleDetections"), sum("mutatedAffected")),
    latencyMs: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
      max: durations.length > 0 && durations.every(finite) ? Math.max(...durations) : null
    }
  });
}

export function compareCandidateSafety(left, right) {
  return left.unsafeActions === right.unsafeActions
    && left.toctouEscapes === right.toctouEscapes
    && left.crossTenantReuse === right.crossTenantReuse;
}
