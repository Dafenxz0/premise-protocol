export const REFERENCE_FORMAT = "premise-efficiency-lab/reference-scenario/v1";

const STATUS_PRIORITY = Object.freeze({ FRESH: 0, STALE: 1, UNKNOWN: 2, INVALID: 3 });

function unique(values) {
  return [...new Set(values)];
}

function mapsFor(nodes) {
  const dependencies = new Map(nodes.map((node) => [node.id, new Set(node.dependsOn ?? [])]));
  const dependents = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const node of nodes) {
    for (const dependency of node.dependsOn ?? []) {
      if (!dependencies.has(dependency)) throw new Error(`Reference graph has unknown dependency: ${dependency}`);
      dependents.get(dependency).add(node.id);
    }
  }
  return { dependencies, dependents };
}

function ancestors(nodeId, dependencies) {
  const seen = new Set();
  const queue = [nodeId];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dependency of dependencies.get(id) ?? []) queue.push(dependency);
  }
  return seen;
}

function reaches(start, target, dependents) {
  const seen = new Set();
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    for (const dependent of dependents.get(id) ?? []) {
      if (dependent === target) return true;
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      queue.push(dependent);
    }
  }
  return false;
}

function minimalRoots(roots, dependents) {
  const result = [];
  for (const root of [...new Set(roots)].sort()) {
    if (result.some((existing) => existing === root || reaches(existing, root, dependents))) continue;
    for (const existing of [...result]) {
      if (reaches(root, existing, dependents)) result.splice(result.indexOf(existing), 1);
    }
    result.push(root);
  }
  return result.sort();
}

/**
 * Small independent semantic reference for the deterministic campaign task.
 * It intentionally does not import runtime-core. Its output is compared with
 * the candidate's normative projection, not with its counters.
 */
export function referenceForTask(spec) {
  const { dependencies, dependents } = mapsFor(spec.nodes);
  const targetId = spec.targetIds?.[0] ?? "memory:target";
  const reachable = ancestors(targetId, dependencies);
  const affected = Boolean(spec.affectsTarget);
  const eventObserved = affected && spec.deliverEvents !== false;
  const dirtyRoots = eventObserved && reachable.has(targetId) ? [targetId] : [];
  const frontier = minimalRoots(dirtyRoots.filter((root) => reachable.has(root)), dependents);

  let decision = "USABLE";
  let coherence = "FRESH";
  let guardDecision = "ALLOW";
  let actionOutcome = { accepted: true, reason: null };
  if (eventObserved) {
    decision = "REJECT";
    coherence = "INVALID";
    guardDecision = "REJECT";
    actionOutcome = { accepted: false, reason: "REJECT" };
  } else if (affected) {
    // Without the invalidation event, the policy record is still fresh, but
    // the connector-owned CAS must reject the stale version at the boundary.
    decision = "USABLE";
    coherence = "FRESH";
    guardDecision = "REVALIDATE";
    actionOutcome = { accepted: false, reason: "VERSION_MISMATCH" };
  }

  return Object.freeze({
    format: REFERENCE_FORMAT,
    decision,
    coherence,
    frontier: Object.freeze({ status: coherence, roots: Object.freeze(frontier), complete: true }),
    guardDecision,
    actionOutcome: Object.freeze(actionOutcome)
  });
}
