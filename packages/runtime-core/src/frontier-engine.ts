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
 * Incremental dependency frontier with conservative cache invalidation.
 *
 * `A -> B` means that B depends on A. The engine keeps direct dirty roots
 * separate from propagated dirty nodes so a large derived closure can still
 * be represented by its minimal causal roots.
 */
export class IncrementalFrontierEngine {
  private readonly dependencies = new Map<string, Set<string>>();
  private readonly dependents = new Map<string, Set<string>>();
  private readonly directDirty = new Map<string, FrontierStatus>();
  private readonly dirtyGeneration = new Map<string, number>();
  private readonly frontierCache = new Map<string, { graphRevision: number; generation: number; result: FrontierResult }>();
  private generation = 0;
  private graphRevision = 0;
  private trusted = true;
  private lastTraversal = { nodesVisited: 0, edgesTraversed: 0, branchesSkippedAlreadyDirty: 0, dirtyPropagations: 0 };

  constructor(nodes: readonly FrontierNode[] = []) {
    for (const node of nodes) this.setDependencies(node.id, node.dependsOn ?? []);
    this.generation = 0;
    this.frontierCache.clear();
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
    this.frontierCache.clear();
  }

  removeNode(id: string): void {
    assertId(id);
    if (!this.dependencies.has(id)) return;
    if ((this.dependents.get(id)?.size ?? 0) > 0) throw new Error(`Cannot remove node with dependents: ${id}`);
    this.removeReverseEdges(id);
    this.dependencies.delete(id);
    this.dependents.delete(id);
    this.directDirty.delete(id);
    this.dirtyGeneration.delete(id);
    this.graphRevision += 1;
    this.generation += 1;
    this.frontierCache.clear();
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
    const affected = this.orderedClosure(direct);
    for (const id of affected) this.dirtyGeneration.set(id, this.generation);
    this.frontierCache.clear();
    return Object.freeze({
      generation: this.generation,
      affected: Object.freeze(affected),
      direct: Object.freeze(direct),
      ...this.lastTraversal
    });
  }

  resolve(nodeId: string): void {
    assertId(nodeId);
    if (!this.dependencies.has(nodeId)) throw new Error(`Unknown node: ${nodeId}`);
    this.directDirty.delete(nodeId);
    this.generation += 1;
    this.dirtyGeneration.set(nodeId, this.generation);
    this.frontierCache.clear();
  }

  markUnknown(): void {
    this.trusted = false;
    this.generation += 1;
    this.frontierCache.clear();
  }

  restoreTrust(): void {
    this.trusted = true;
    this.generation += 1;
    this.frontierCache.clear();
  }

  frontier(nodeId: string): FrontierResult {
    assertId(nodeId);
    if (!this.dependencies.has(nodeId)) throw new Error(`Unknown node: ${nodeId}`);
    const cached = this.frontierCache.get(nodeId);
    if (cached?.graphRevision === this.graphRevision && cached.generation === this.generation) {
      return Object.freeze({ ...cached.result, cacheHit: true });
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
    const reachable = new Set<string>();
    let status: FrontierStatus = "FRESH";
    const visiting = new Set<string>();
    let nodesVisited = 0;
    let edgesTraversed = 0;
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`);
      if (reachable.has(id)) return;
      visiting.add(id);
      reachable.add(id);
      nodesVisited += 1;
      for (const dependencyId of this.dependencies.get(id) ?? []) {
        edgesTraversed += 1;
        visit(dependencyId);
      }
      visiting.delete(id);
    };
    visit(nodeId);
    const relevantDirty = [...reachable].filter((id) => this.directDirty.has(id));
    for (const id of relevantDirty) status = statusMax(status, this.directDirty.get(id)!);
    const frontier = this.compress(relevantDirty);
    const result = Object.freeze({
      status,
      frontier: Object.freeze(frontier),
      complete: true,
      cacheHit: false,
      graphRevision: this.graphRevision,
      impactGeneration,
      nodesVisited,
      edgesTraversed
    });
    return this.cache(nodeId, result);
  }

  status(nodeId: string): FrontierStatus {
    return this.frontier(nodeId).status;
  }

  stats(): Readonly<{ graphRevision: number; generation: number; nodeCount: number; directDirtyCount: number; trusted: boolean; cacheEntries: number }> {
    return Object.freeze({
      graphRevision: this.graphRevision,
      generation: this.generation,
      nodeCount: this.dependencies.size,
      directDirtyCount: this.directDirty.size,
      trusted: this.trusted,
      cacheEntries: this.frontierCache.size
    });
  }

  private cache(nodeId: string, result: FrontierResult): FrontierResult {
    this.frontierCache.set(nodeId, { graphRevision: this.graphRevision, generation: this.generation, result });
    return result;
  }

  private orderedClosure(seeds: readonly string[]): string[] {
    let nodesVisited = 0;
    let edgesTraversed = 0;
    let branchesSkippedAlreadyDirty = 0;
    let dirtyPropagations = 0;
    const seen = new Set<string>();
    const queue = [...seeds];
    for (const id of seeds) seen.add(id);
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index]!;
      nodesVisited += 1;
      for (const dependent of [...(this.dependents.get(id) ?? [])].sort()) {
        edgesTraversed += 1;
        if (seen.has(dependent)) continue;
        if (this.dirtyGeneration.has(dependent)) branchesSkippedAlreadyDirty += 1;
        seen.add(dependent);
        queue.push(dependent);
        dirtyPropagations += 1;
      }
    }
    this.lastTraversal = { nodesVisited, edgesTraversed, branchesSkippedAlreadyDirty, dirtyPropagations };
    return queue;
  }

  private compress(ids: readonly string[]): string[] {
    const uniqueIds = unique(ids).sort();
    return uniqueIds.filter((candidate) => !uniqueIds.some((other) => other !== candidate && this.reaches(other, candidate)));
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
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependencyId of this.dependencies.get(id) ?? []) visit(dependencyId);
      visiting.delete(id);
      visited.add(id);
    };
    visit(start);
  }
}
