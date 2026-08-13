export type FrontierStatus = "FRESH" | "STALE" | "INVALID" | "UNKNOWN";

export interface FrontierNode {
  readonly id: string;
  readonly dependsOn?: readonly string[];
}

export interface FrontierResult {
  readonly status: FrontierStatus;
  readonly frontier: readonly string[];
  readonly complete: boolean;
  readonly cacheHit: boolean;
  readonly graphRevision: number;
  readonly impactGeneration: number;
  readonly nodesVisited: number;
  readonly edgesTraversed: number;
}

export interface FrontierImpact {
  readonly generation: number;
  readonly affected: readonly string[];
  readonly direct: readonly string[];
  readonly nodesVisited: number;
  readonly edgesTraversed: number;
  readonly branchesSkippedAlreadyDirty: number;
  readonly dirtyPropagations: number;
  readonly frontierCacheInvalidations: number;
  readonly frontierCacheEntriesPreserved: number;
}

interface DirtyState {
  readonly generation: number;
  readonly graphRevision: number;
  readonly status: FrontierStatus;
  readonly causalRoots: readonly string[];
  readonly frontier: readonly string[];
}

interface FrontierCacheEntry {
  readonly graphRevision: number;
  readonly result: FrontierResult;
}

const STATUS_PRIORITY: Readonly<Record<FrontierStatus, number>> = Object.freeze({ FRESH: 0, STALE: 1, UNKNOWN: 2, INVALID: 3 });

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function statusMax(left: FrontierStatus, right: FrontierStatus): FrontierStatus {
  return STATUS_PRIORITY[left] >= STATUS_PRIORITY[right] ? left : right;
}

function assertId(id: string, name = "node id"): void {
  if (typeof id !== "string" || id.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

/**
 * Incremental dependency frontier with targeted invalidation.
 *
 * `A -> B` means that B depends on A. Dirty roots are propagated once into
 * maintained per-node state. Frontier queries then read that state instead
 * of walking all ancestors. The state is conservative: an unknown graph or
 * a failed update is never promoted to fresh evidence.
 */
export class IncrementalFrontierEngine {
  private readonly dependencies = new Map<string, Set<string>>();
  private readonly dependents = new Map<string, Set<string>>();
  private readonly directDirty = new Map<string, FrontierStatus>();
  private readonly activeDirtyRoots = new Map<string, Map<string, FrontierStatus>>();
  private readonly activeFrontiers = new Map<string, Set<string>>();
  private readonly dirtyNodesByRoot = new Map<string, Set<string>>();
  private readonly dirtyStates = new Map<string, DirtyState>();
  private readonly frontierCache = new Map<string, FrontierCacheEntry>();
  private generation = 0;
  private graphRevision = 0;
  private trusted = true;
  private cacheInvalidations = 0;
  private cacheEntriesPreserved = 0;
  private lastCacheDelta = { invalidations: 0, preserved: 0 };
  private lastTraversal = { nodesVisited: 0, edgesTraversed: 0, branchesSkippedAlreadyDirty: 0, dirtyPropagations: 0 };

  constructor(nodes: readonly FrontierNode[] = []) {
    // Bulk-build the immutable initial graph. Calling setDependencies for
    // every node would clone the whole index and rebuild all dirty state on
    // each insertion, turning construction of a deep graph into O(V²).
    for (const node of nodes) {
      assertId(node.id);
      const dependencies = unique(node.dependsOn ?? []);
      for (const dependencyId of dependencies) {
        assertId(dependencyId, "dependency id");
        if (dependencyId === node.id) throw new Error(`Dependency cycle at ${node.id}`);
        if (!this.dependencies.has(dependencyId)) this.dependencies.set(dependencyId, new Set());
      }
      this.dependencies.set(node.id, new Set(dependencies));
    }
    for (const id of this.dependencies.keys()) this.dependents.set(id, new Set());
    for (const [id, dependencies] of this.dependencies) {
      for (const dependencyId of dependencies) this.dependents.get(dependencyId)!.add(id);
    }
    this.assertAcyclicGraph();
    this.graphRevision = nodes.length;
    this.generation = nodes.length;
    this.rebuildDirtyState();
  }

  addNode(id: string, dependsOn: readonly string[] = []): void {
    assertId(id);
    if (this.dependencies.has(id)) throw new Error(`Node already exists: ${id}`);
    this.setDependencies(id, dependsOn);
  }

  setDependencies(id: string, dependsOn: readonly string[]): void {
    assertId(id);
    const next = unique(dependsOn);
    const previousDependencies = new Map([...this.dependencies].map(([nodeId, values]) => [nodeId, new Set(values)] as const));
    const previousDependents = new Map([...this.dependents].map(([nodeId, values]) => [nodeId, new Set(values)] as const));
    for (const dependencyId of next) {
      assertId(dependencyId, "dependency id");
      if (dependencyId === id) throw new Error(`Dependency cycle at ${id}`);
      if (!this.dependencies.has(dependencyId)) this.dependencies.set(dependencyId, new Set());
    }
    if (this.dependencies.has(id)) this.removeReverseEdges(id);
    this.dependencies.set(id, new Set(next));
    for (const dependencyId of next) {
      const set = this.dependents.get(dependencyId) ?? new Set<string>();
      set.add(id);
      this.dependents.set(dependencyId, set);
    }
    try {
      this.assertAcyclic(id);
    } catch (error) {
      this.dependencies.clear();
      for (const [nodeId, values] of previousDependencies) this.dependencies.set(nodeId, values);
      this.dependents.clear();
      for (const [nodeId, values] of previousDependents) this.dependents.set(nodeId, values);
      throw error;
    }
    this.graphRevision += 1;
    this.generation += 1;
    this.rebuildDirtyState();
    this.invalidateAllCaches();
  }

  removeNode(id: string): void {
    assertId(id);
    if (!this.dependencies.has(id)) return;
    if ((this.dependents.get(id)?.size ?? 0) > 0) throw new Error(`Cannot remove node with dependents: ${id}`);
    this.removeReverseEdges(id);
    this.dependencies.delete(id);
    this.dependents.delete(id);
    this.directDirty.delete(id);
    this.graphRevision += 1;
    this.generation += 1;
    this.rebuildDirtyState();
    this.invalidateAllCaches();
  }

  markDirty(nodeIds: readonly string[], status: Exclude<FrontierStatus, "FRESH"> = "STALE"): FrontierImpact {
    const direct = unique(nodeIds);
    for (const id of direct) {
      assertId(id);
      if (!this.dependencies.has(id)) throw new Error(`Unknown node: ${id}`);
    }
    this.generation += 1;
    for (const id of direct) {
      const previous = this.directDirty.get(id);
      this.directDirty.set(id, previous === undefined ? status : statusMax(previous, status));
    }
    const impact = this.propagateDirty(direct.map((id) => [id, this.directDirty.get(id)!] as const));
    const cache = this.invalidateTargets(new Set(impact.affected));
    return Object.freeze({
      generation: this.generation,
      direct: Object.freeze(direct),
      ...impact,
      frontierCacheInvalidations: cache.invalidations,
      frontierCacheEntriesPreserved: cache.preserved
    });
  }

  /**
   * Restore direct validity states from a persisted store in one propagation
   * pass. This keeps reconstruction work accounted for without replaying one
   * complete graph walk per record.
   */
  restoreStates(states: readonly Readonly<{ id: string; status: FrontierStatus }>[]): void {
    const next = new Map<string, FrontierStatus>();
    for (const { id, status } of states) {
      assertId(id);
      if (!this.dependencies.has(id)) throw new Error(`Unknown node: ${id}`);
      if (status !== "FRESH") next.set(id, status);
    }
    this.directDirty.clear();
    for (const [id, status] of next) this.directDirty.set(id, status);
    this.generation += 1;
    this.rebuildDirtyState();
    this.invalidateAllCaches();
  }

  /**
   * Replace a node's persisted validity state, allowing a fresh replacement
   * to remove an older INVALID/STALE root without relaxing other causes.
   */
  replaceStatus(nodeId: string, status: FrontierStatus): FrontierImpact {
    assertId(nodeId);
    if (!this.dependencies.has(nodeId)) throw new Error(`Unknown node: ${nodeId}`);
    const affected = this.descendantClosure(nodeId);
    this.directDirty.delete(nodeId);
    if (status !== "FRESH") this.directDirty.set(nodeId, status);
    this.generation += 1;
    this.rebuildDirtyState();
    const cache = this.invalidateTargets(affected);
    return Object.freeze({
      generation: this.generation,
      affected: Object.freeze([...affected].sort()),
      direct: Object.freeze([nodeId]),
      nodesVisited: this.lastTraversal.nodesVisited,
      edgesTraversed: this.lastTraversal.edgesTraversed,
      branchesSkippedAlreadyDirty: this.lastTraversal.branchesSkippedAlreadyDirty,
      dirtyPropagations: this.lastTraversal.dirtyPropagations,
      frontierCacheInvalidations: cache.invalidations,
      frontierCacheEntriesPreserved: cache.preserved
    });
  }

  resolve(nodeId: string): FrontierImpact {
    assertId(nodeId);
    if (!this.dependencies.has(nodeId)) throw new Error(`Unknown node: ${nodeId}`);
    const affected = [...(this.dirtyNodesByRoot.get(nodeId) ?? new Set([nodeId]))].sort();
    this.directDirty.delete(nodeId);
    this.dirtyNodesByRoot.delete(nodeId);
    for (const id of affected) {
      const roots = this.activeDirtyRoots.get(id);
      if (roots === undefined) continue;
      roots.delete(nodeId);
      if (roots.size === 0) {
        this.activeDirtyRoots.delete(id);
        this.activeFrontiers.delete(id);
        this.dirtyStates.delete(id);
      } else {
        this.activeFrontiers.set(id, this.computeFrontier(roots.keys()));
        this.updateDirtyState(id);
      }
    }
    this.generation += 1;
    const impact = Object.freeze({
      generation: this.generation,
      affected: Object.freeze(affected),
      direct: Object.freeze([nodeId]),
      nodesVisited: affected.length,
      edgesTraversed: 0,
      branchesSkippedAlreadyDirty: 0,
      dirtyPropagations: affected.length
    });
    this.lastTraversal = {
      nodesVisited: impact.nodesVisited,
      edgesTraversed: impact.edgesTraversed,
      branchesSkippedAlreadyDirty: impact.branchesSkippedAlreadyDirty,
      dirtyPropagations: impact.dirtyPropagations
    };
    const cache = this.invalidateTargets(new Set(affected));
    return Object.freeze({ ...impact, frontierCacheInvalidations: cache.invalidations, frontierCacheEntriesPreserved: cache.preserved });
  }

  markUnknown(): void {
    this.trusted = false;
    this.generation += 1;
    this.invalidateAllCaches();
  }

  restoreTrust(): void {
    this.trusted = true;
    this.generation += 1;
    this.invalidateAllCaches();
  }

  frontier(nodeId: string): FrontierResult {
    assertId(nodeId);
    if (!this.dependencies.has(nodeId)) throw new Error(`Unknown node: ${nodeId}`);
    const cached = this.frontierCache.get(nodeId);
    if (cached?.graphRevision === this.graphRevision) {
      return Object.freeze({ ...cached.result, cacheHit: true, impactGeneration: this.generation, nodesVisited: 0, edgesTraversed: 0 });
    }
    const impactGeneration = this.generation;
    if (!this.trusted) {
      return this.cache(nodeId, Object.freeze({
        status: "UNKNOWN",
        frontier: Object.freeze([]),
        complete: false,
        cacheHit: false,
        graphRevision: this.graphRevision,
        impactGeneration,
        nodesVisited: 0,
        edgesTraversed: 0
      }));
    }
    const roots = this.activeDirtyRoots.get(nodeId);
    const status = roots === undefined
      ? "FRESH"
      : [...roots.values()].reduce<FrontierStatus>((current, value) => statusMax(current, value), "FRESH");
    const result = Object.freeze({
      status,
      frontier: Object.freeze([...(this.activeFrontiers.get(nodeId) ?? [])].sort()),
      complete: true,
      cacheHit: false,
      graphRevision: this.graphRevision,
      impactGeneration,
      // The maintained index is a single lookup; the mutation paid for its
      // propagation separately. This is the O(F) query path.
      nodesVisited: 1,
      edgesTraversed: 0
    });
    return this.cache(nodeId, result);
  }

  status(nodeId: string): FrontierStatus {
    return this.frontier(nodeId).status;
  }

  stats(): Readonly<{
    graphRevision: number;
    generation: number;
    nodeCount: number;
    directDirtyCount: number;
    activeDirtyNodeCount: number;
    activeDirtyRootCount: number;
    trusted: boolean;
    cacheEntries: number;
    frontierCacheInvalidations: number;
    frontierCacheEntriesPreserved: number;
    cachePreservationRate: number | null;
  }> {
    const eligibleEntries = this.cacheInvalidations + this.cacheEntriesPreserved;
    return Object.freeze({
      graphRevision: this.graphRevision,
      generation: this.generation,
      nodeCount: this.dependencies.size,
      directDirtyCount: this.directDirty.size,
      activeDirtyNodeCount: this.activeDirtyRoots.size,
      activeDirtyRootCount: [...this.activeDirtyRoots.values()].reduce((sum, roots) => sum + roots.size, 0),
      trusted: this.trusted,
      cacheEntries: this.frontierCache.size,
      frontierCacheInvalidations: this.cacheInvalidations,
      frontierCacheEntriesPreserved: this.cacheEntriesPreserved,
      cachePreservationRate: eligibleEntries === 0 ? null : this.cacheEntriesPreserved / eligibleEntries
    });
  }

  private cache(nodeId: string, result: FrontierResult): FrontierResult {
    this.frontierCache.set(nodeId, { graphRevision: this.graphRevision, result });
    return result;
  }

  private propagateDirty(seeds: readonly (readonly [string, FrontierStatus])[]): Omit<FrontierImpact, "generation" | "direct" | "frontierCacheInvalidations" | "frontierCacheEntriesPreserved"> {
    let nodesVisited = 0;
    let edgesTraversed = 0;
    let branchesSkippedAlreadyDirty = 0;
    let dirtyPropagations = 0;
    const affected = new Set<string>();
    const queue: Array<readonly [string, ReadonlyMap<string, FrontierStatus>]> = [];
    for (const [id, value] of seeds) {
      affected.add(id);
      const roots = new Map([[id, value]]);
      if (this.mergeDirtyState(id, roots)) {
        queue.push([id, this.activeDirtyRoots.get(id)!]);
      } else {
        // The complete affected set is already indexed by root. Reporting
        // the skipped downstream branches does not require walking them.
        branchesSkippedAlreadyDirty += Math.max(0, (this.dirtyNodesByRoot.get(id)?.size ?? 1) - 1);
      }
      for (const known of this.dirtyNodesByRoot.get(id) ?? []) affected.add(known);
    }
    for (let index = 0; index < queue.length; index += 1) {
      const [id, roots] = queue[index]!;
      nodesVisited += 1;
      for (const dependent of [...(this.dependents.get(id) ?? [])].sort()) {
        edgesTraversed += 1;
        for (const affectedRoot of roots.keys()) affected.add(dependent);
        const changed = this.mergeDirtyState(dependent, roots);
        if (!changed) {
          // The dependent already contains every incoming root at an equal or
          // stronger severity for this graph revision. No branch traversal is
          // needed for this generation.
          branchesSkippedAlreadyDirty += 1;
          continue;
        }
        dirtyPropagations += 1;
        queue.push([dependent, this.activeDirtyRoots.get(dependent)!]);
      }
    }
    this.lastTraversal = { nodesVisited, edgesTraversed, branchesSkippedAlreadyDirty, dirtyPropagations };
    return Object.freeze({
      affected: Object.freeze([...affected].sort()),
      nodesVisited,
      edgesTraversed,
      branchesSkippedAlreadyDirty,
      dirtyPropagations
    });
  }

  private mergeDirtyState(nodeId: string, incoming: ReadonlyMap<string, FrontierStatus>): boolean {
    const roots = this.activeDirtyRoots.get(nodeId) ?? new Map<string, FrontierStatus>();
    let changed = false;
    for (const [root, status] of incoming) {
      const previous = roots.get(root);
      if (previous !== undefined && STATUS_PRIORITY[previous] >= STATUS_PRIORITY[status]) continue;
      roots.set(root, status);
      changed = true;
      const nodes = this.dirtyNodesByRoot.get(root) ?? new Set<string>();
      nodes.add(nodeId);
      this.dirtyNodesByRoot.set(root, nodes);
    }
    if (!changed) return false;
    this.activeDirtyRoots.set(nodeId, roots);
    const frontier = this.activeFrontiers.get(nodeId) ?? new Set<string>();
    for (const root of incoming.keys()) this.addFrontierRoot(frontier, root);
    this.activeFrontiers.set(nodeId, frontier);
    this.updateDirtyState(nodeId);
    return true;
  }

  private updateDirtyState(nodeId: string): void {
    const roots = this.activeDirtyRoots.get(nodeId);
    if (roots === undefined) return;
    const status = [...roots.values()].reduce<FrontierStatus>((current, value) => statusMax(current, value), "FRESH");
    this.dirtyStates.set(nodeId, Object.freeze({
      generation: this.generation,
      graphRevision: this.graphRevision,
      status,
      causalRoots: Object.freeze([...roots.keys()].sort()),
      frontier: Object.freeze([...(this.activeFrontiers.get(nodeId) ?? [])].sort())
    }));
  }

  private addFrontierRoot(frontier: Set<string>, root: string): void {
    for (const existing of [...frontier]) {
      if (existing === root || this.reaches(existing, root)) return;
      if (this.reaches(root, existing)) frontier.delete(existing);
    }
    frontier.add(root);
  }

  private computeFrontier(roots: Iterable<string>): Set<string> {
    const result = new Set<string>();
    for (const root of roots) this.addFrontierRoot(result, root);
    return result;
  }

  private rebuildDirtyState(): void {
    this.activeDirtyRoots.clear();
    this.activeFrontiers.clear();
    this.dirtyNodesByRoot.clear();
    this.dirtyStates.clear();
    if (this.directDirty.size > 0) {
      this.propagateDirty([...this.directDirty.entries()]);
    } else {
      this.lastTraversal = { nodesVisited: 0, edgesTraversed: 0, branchesSkippedAlreadyDirty: 0, dirtyPropagations: 0 };
    }
  }

  private invalidateTargets(targets: ReadonlySet<string>): { invalidations: number; preserved: number } {
    let invalidations = 0;
    let preserved = 0;
    if (this.frontierCache.size === 0) {
      this.lastCacheDelta = { invalidations, preserved };
      return this.lastCacheDelta;
    }
    for (const nodeId of [...this.frontierCache.keys()]) {
      if (targets.has(nodeId)) {
        this.frontierCache.delete(nodeId);
        this.cacheInvalidations += 1;
        invalidations += 1;
      } else {
        this.cacheEntriesPreserved += 1;
        preserved += 1;
      }
    }
    this.lastCacheDelta = { invalidations, preserved };
    return this.lastCacheDelta;
  }

  private invalidateAllCaches(): void {
    const invalidations = this.frontierCache.size;
    this.cacheInvalidations += invalidations;
    this.frontierCache.clear();
    this.lastCacheDelta = { invalidations, preserved: 0 };
  }

  private reaches(start: string, target: string): boolean {
    const seen = new Set<string>();
    const queue = [start];
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index]!;
      for (const dependent of this.dependents.get(id) ?? []) {
        if (dependent === target) return true;
        if (seen.has(dependent)) continue;
        seen.add(dependent);
        queue.push(dependent);
      }
    }
    return false;
  }

  private removeReverseEdges(id: string): void {
    for (const dependencyId of this.dependencies.get(id) ?? []) {
      const dependents = this.dependents.get(dependencyId);
      dependents?.delete(id);
      if (dependents?.size === 0) this.dependents.delete(dependencyId);
    }
  }

  private assertAcyclic(start: string): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: Array<{ id: string; exit: boolean }> = [{ id: start, exit: false }];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.exit) {
        visiting.delete(frame.id);
        visited.add(frame.id);
        continue;
      }
      if (visited.has(frame.id)) continue;
      if (visiting.has(frame.id)) throw new Error(`Dependency cycle at ${frame.id}`);
      visiting.add(frame.id);
      stack.push({ id: frame.id, exit: true });
      const dependencies = [...(this.dependencies.get(frame.id) ?? [])].reverse();
      for (const dependencyId of dependencies) {
        if (visiting.has(dependencyId)) throw new Error(`Dependency cycle at ${dependencyId}`);
        if (!visited.has(dependencyId)) stack.push({ id: dependencyId, exit: false });
      }
    }
  }

  private descendantClosure(start: string): Set<string> {
    const affected = new Set([start]);
    const queue = [start];
    for (let index = 0; index < queue.length; index += 1) {
      for (const dependent of this.dependents.get(queue[index]!) ?? []) {
        if (affected.has(dependent)) continue;
        affected.add(dependent);
        queue.push(dependent);
      }
    }
    return affected;
  }

  private assertAcyclicGraph(): void {
    const state = new Map<string, 0 | 1 | 2>();
    for (const start of this.dependencies.keys()) {
      if (state.get(start) === 2) continue;
      state.set(start, 1);
      const stack: Array<{ id: string; dependencies: string[]; index: number }> = [{
        id: start,
        dependencies: [...(this.dependencies.get(start) ?? [])],
        index: 0
      }];
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        if (frame.index >= frame.dependencies.length) {
          state.set(frame.id, 2);
          stack.pop();
          continue;
        }
        const dependencyId = frame.dependencies[frame.index++]!;
        const dependencyState = state.get(dependencyId) ?? 0;
        if (dependencyState === 1) throw new Error(`Dependency cycle at ${dependencyId}`);
        if (dependencyState === 2) continue;
        state.set(dependencyId, 1);
        stack.push({ id: dependencyId, dependencies: [...(this.dependencies.get(dependencyId) ?? [])], index: 0 });
      }
    }
  }
}
