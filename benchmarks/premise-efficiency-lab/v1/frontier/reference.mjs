const PRIORITY = Object.freeze({ FRESH: 0, STALE: 1, UNKNOWN: 2, INVALID: 3 });

function statusMax(left, right) {
  return PRIORITY[left] >= PRIORITY[right] ? left : right;
}

function unique(values) {
  return [...new Set(values)];
}

export class FullTraversalReference {
  constructor(nodes) {
    this.dependencies = new Map(nodes.map(({ id, dependsOn }) => [id, new Set(dependsOn ?? [])]));
    this.dependents = new Map(nodes.map(({ id }) => [id, new Set()]));
    for (const [id, dependencies] of this.dependencies) {
      for (const dependency of dependencies) {
        if (!this.dependents.has(dependency)) throw new Error(`unknown dependency ${dependency}`);
        this.dependents.get(dependency).add(id);
      }
    }
    this.directDirty = new Map();
    this.lastReachabilityNodesVisited = 0;
    this.lastReachabilityEdgesTraversed = 0;
  }

  markDirty(ids, status = "STALE") {
    for (const id of ids) this.directDirty.set(id, statusMax(this.directDirty.get(id) ?? "FRESH", status));
    const queue = unique(ids);
    const affected = new Set(queue);
    let nodesVisited = 0;
    let edgesTraversed = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const id = queue[cursor];
      nodesVisited += 1;
      for (const dependent of [...(this.dependents.get(id) ?? [])].sort()) {
        edgesTraversed += 1;
        if (affected.has(dependent)) continue;
        affected.add(dependent);
        queue.push(dependent);
      }
    }
    return Object.freeze({ affected: Object.freeze([...affected].sort()), nodesVisited, edgesTraversed });
  }

  resolve(id) {
    this.directDirty.delete(id);
  }

  frontier(target) {
    const reachable = new Set();
    const queue = [target];
    let nodesVisited = 0;
    let edgesTraversed = 0;
    this.lastReachabilityNodesVisited = 0;
    this.lastReachabilityEdgesTraversed = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const id = queue[cursor];
      if (reachable.has(id)) continue;
      reachable.add(id);
      nodesVisited += 1;
      for (const dependency of [...(this.dependencies.get(id) ?? [])].sort()) {
        edgesTraversed += 1;
        queue.push(dependency);
      }
    }
    const roots = [...reachable].filter((id) => this.directDirty.has(id)).sort();
    const frontier = roots.filter((candidate) => !roots.some((other) => {
      if (other === candidate) return false;
      return this.reaches(other, candidate);
    }));
    const status = roots.reduce((current, id) => statusMax(current, this.directDirty.get(id)), "FRESH");
    return Object.freeze({
      status,
      frontier: Object.freeze(frontier),
      complete: true,
      nodesVisited: nodesVisited + this.lastReachabilityNodesVisited,
      edgesTraversed: edgesTraversed + this.lastReachabilityEdgesTraversed,
      cacheHit: false
    });
  }

  reaches(start, target) {
    const seen = new Set();
    const queue = [start];
    let nodesVisited = 0;
    let edgesTraversed = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const id = queue[cursor];
      nodesVisited += 1;
      for (const dependent of this.dependents.get(id) ?? []) {
        edgesTraversed += 1;
        if (dependent === target) {
          this.lastReachabilityNodesVisited += nodesVisited;
          this.lastReachabilityEdgesTraversed += edgesTraversed;
          return true;
        }
        if (seen.has(dependent)) continue;
        seen.add(dependent);
        queue.push(dependent);
      }
    }
    this.lastReachabilityNodesVisited += nodesVisited;
    this.lastReachabilityEdgesTraversed += edgesTraversed;
    return false;
  }
}

/**
 * Champion baseline reconstructed from the c86a6ea frontier implementation:
 * it recomputes all ancestors on a cache miss, while invalidating only cached
 * targets in the affected closure. It is kept separate from the normative
 * full traversal reference above.
 */
export class ChampionV1Frontier extends FullTraversalReference {
  constructor(nodes) {
    super(nodes);
    this.cache = new Map();
    this.generation = 0;
    this.activeDirtyRoots = new Map();
    this.dirtyNodesByRoot = new Map();
  }

  markDirty(ids, status = "STALE") {
    const direct = unique(ids);
    for (const id of direct) {
      const previous = this.directDirty.get(id);
      this.directDirty.set(id, statusMax(previous ?? "FRESH", status));
    }
    const queue = [];
    const affectedNodes = new Set();
    let nodesVisited = 0;
    let edgesTraversed = 0;
    let branchesSkippedAlreadyDirty = 0;
    for (const id of direct) {
      affectedNodes.add(id);
      const roots = new Map([[id, this.directDirty.get(id)]]);
      if (this.mergeDirtyState(id, roots)) queue.push([id, this.activeDirtyRoots.get(id)]);
      else branchesSkippedAlreadyDirty += Math.max(0, (this.dirtyNodesByRoot.get(id)?.size ?? 1) - 1);
      for (const known of this.dirtyNodesByRoot.get(id) ?? []) affectedNodes.add(known);
    }
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const [id, roots] = queue[cursor];
      nodesVisited += 1;
      for (const dependent of [...(this.dependents.get(id) ?? [])].sort()) {
        edgesTraversed += 1;
        affectedNodes.add(dependent);
        if (!this.mergeDirtyState(dependent, roots)) {
          branchesSkippedAlreadyDirty += 1;
          continue;
        }
        queue.push([dependent, this.activeDirtyRoots.get(dependent)]);
      }
    }
    for (const nodes of this.dirtyNodesByRoot.values()) for (const id of nodes) affectedNodes.add(id);
    const impact = Object.freeze({ affected: Object.freeze([...affectedNodes].sort()), nodesVisited, edgesTraversed, branchesSkippedAlreadyDirty });
    this.generation += 1;
    const affected = new Set(impact.affected);
    for (const target of [...this.cache.keys()]) {
      if (affected.has(target)) this.cache.delete(target);
    }
    return impact;
  }

  mergeDirtyState(nodeId, incoming) {
    const roots = this.activeDirtyRoots.get(nodeId) ?? new Map();
    let changed = false;
    for (const [root, status] of incoming) {
      const previous = roots.get(root);
      if (previous !== undefined && PRIORITY[previous] >= PRIORITY[status]) continue;
      roots.set(root, status);
      changed = true;
      const nodes = this.dirtyNodesByRoot.get(root) ?? new Set();
      nodes.add(nodeId);
      this.dirtyNodesByRoot.set(root, nodes);
    }
    if (changed) this.activeDirtyRoots.set(nodeId, roots);
    return changed;
  }

  resolve(id) {
    this.directDirty.delete(id);
    this.activeDirtyRoots.clear();
    this.dirtyNodesByRoot.clear();
    for (const [root, status] of this.directDirty) this.markDirty([root], status);
    this.generation += 1;
    const affected = new Set([id]);
    const queue = [id];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      for (const dependent of this.dependents.get(queue[cursor]) ?? []) {
        if (affected.has(dependent)) continue;
        affected.add(dependent);
        queue.push(dependent);
      }
    }
    for (const target of [...this.cache.keys()]) {
      if (affected.has(target)) this.cache.delete(target);
    }
  }

  frontier(target) {
    const cached = this.cache.get(target);
    if (cached !== undefined) return Object.freeze({ ...cached, cacheHit: true, nodesVisited: 0, edgesTraversed: 0 });
    const result = super.frontier(target);
    const stored = Object.freeze({ ...result, cacheHit: false });
    this.cache.set(target, stored);
    return stored;
  }
}
