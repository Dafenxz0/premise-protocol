export type FrontierStatus = "FRESH" | "STALE" | "INVALID" | "UNKNOWN";

export interface FrontierNode {
  readonly id: string;
  readonly dependsOn?: readonly string[];
}

export type FrontierWorkPhase = "initialization" | "maintenance" | "query";

export interface FrontierPrimitiveCounters {
  readonly graphNodeLookups: number;
  readonly graphEdgeTraversals: number;
  readonly reverseIndexLookups: number;
  readonly dirtyStateReads: number;
  readonly dirtyStateWrites: number;
  readonly frontierLookups: number;
  readonly frontierRootComparisons: number;
  readonly reachabilityQueries: number;
  readonly reachabilityCacheLookups: number;
  readonly reachabilityCacheHits: number;
  readonly reachabilityCacheMisses: number;
  readonly reachabilityCacheWrites: number;
  readonly reachabilityCacheWriteSkips: number;
  readonly reachabilityCacheEvictions: number;
  readonly reachabilityCacheEntriesCleared: number;
  readonly reachabilityNodesVisited: number;
  readonly reachabilityEdgesTraversed: number;
  readonly cacheLookups: number;
  readonly cacheEntriesScanned: number;
  readonly cacheEntriesPreserved: number;
  readonly cacheInvalidations: number;
  readonly cacheWrites: number;
  readonly rootSetReads: number;
  readonly rootSetWrites: number;
}

export interface FrontierWorkBreakdown {
  readonly initialization: FrontierPrimitiveCounters;
  readonly maintenance: FrontierPrimitiveCounters;
  readonly query: FrontierPrimitiveCounters;
  readonly initializationWork: number;
  readonly maintenanceWork: number;
  readonly queryWork: number;
  readonly totalWork: number;
  readonly initializationGraphWork: number;
  readonly maintenanceGraphWork: number;
  readonly queryGraphWork: number;
  readonly graphWork: number;
  readonly primitiveWork: number;
  readonly reconciled: boolean;
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
  readonly workBreakdown: FrontierWorkBreakdown;
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
  readonly frontierComplete: boolean;
  readonly workBreakdown: FrontierWorkBreakdown;
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

const COUNTER_KEYS = Object.freeze([
  "graphNodeLookups", "graphEdgeTraversals", "reverseIndexLookups", "dirtyStateReads", "dirtyStateWrites",
  "frontierLookups", "frontierRootComparisons", "reachabilityQueries", "reachabilityCacheLookups", "reachabilityCacheHits",
  "reachabilityCacheMisses", "reachabilityCacheWrites", "reachabilityCacheWriteSkips", "reachabilityCacheEvictions", "reachabilityCacheEntriesCleared", "reachabilityNodesVisited",
  "reachabilityEdgesTraversed", "cacheLookups", "cacheEntriesScanned", "cacheInvalidations", "cacheWrites",
  "cacheEntriesPreserved",
  "rootSetReads", "rootSetWrites"
] as const);

const GRAPH_WORK_KEYS = Object.freeze([
  "graphNodeLookups", "graphEdgeTraversals", "reachabilityNodesVisited", "reachabilityEdgesTraversed"
] as const);

type CounterKey = typeof COUNTER_KEYS[number];
type MutableCounters = { -readonly [Key in CounterKey]: number };
type CounterBook = { [Phase in FrontierWorkPhase]: MutableCounters };

const MAX_REACHABILITY_CACHE_ENTRIES = 65_536;
const MAX_FRONTIER_ROOT_COMPARISONS = 5_000_000;
const MAX_FRONTIER_REACHABILITY_WORK = 5_000_000;
const MAX_ACTIVE_ROOT_STATE_ENTRIES = 5_000_000;

function blankCounters(): MutableCounters {
  return Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0])) as MutableCounters;
}

function blankCounterBook(): CounterBook {
  return { initialization: blankCounters(), maintenance: blankCounters(), query: blankCounters() };
}

function freezeCounters(counters: MutableCounters): FrontierPrimitiveCounters {
  return Object.freeze({ ...counters });
}

function sumCounters(counters: FrontierPrimitiveCounters): number {
  return COUNTER_KEYS.reduce((sum, key) => sum + counters[key], 0);
}

function sumGraphCounters(counters: FrontierPrimitiveCounters): number {
  return GRAPH_WORK_KEYS.reduce((sum, key) => sum + counters[key], 0);
}

function deltaCounters(before: MutableCounters, after: MutableCounters): FrontierPrimitiveCounters {
  return freezeCounters(Object.fromEntries(COUNTER_KEYS.map((key) => [key, after[key] - before[key]])) as MutableCounters);
}

function workBreakdown(before: CounterBook, after: CounterBook): FrontierWorkBreakdown {
  const initialization = deltaCounters(before.initialization, after.initialization);
  const maintenance = deltaCounters(before.maintenance, after.maintenance);
  const query = deltaCounters(before.query, after.query);
  const initializationWork = sumCounters(initialization);
  const maintenanceWork = sumCounters(maintenance);
  const queryWork = sumCounters(query);
  const totalWork = maintenanceWork + queryWork;
  const initializationGraphWork = sumGraphCounters(initialization);
  const maintenanceGraphWork = sumGraphCounters(maintenance);
  const queryGraphWork = sumGraphCounters(query);
  const graphWork = maintenanceGraphWork + queryGraphWork;
  const primitiveWork = maintenanceWork + queryWork;
  const counters = [initialization, maintenance, query];
  const finite = counters.every((book) => COUNTER_KEYS.every((key) => Number.isSafeInteger(book[key]) && book[key] >= 0));
  const cacheAccounting = counters.every((book) => book.cacheEntriesScanned === book.cacheInvalidations + book.cacheEntriesPreserved);
  const reachabilityAccounting = counters.every((book) =>
    book.reachabilityQueries === book.reachabilityCacheLookups
      && book.reachabilityCacheLookups === book.reachabilityCacheHits + book.reachabilityCacheMisses
      && book.reachabilityCacheMisses === book.reachabilityCacheWrites + book.reachabilityCacheWriteSkips
  );
  const reconciled = finite && cacheAccounting && reachabilityAccounting;
  return Object.freeze({ initialization, maintenance, query, initializationWork, maintenanceWork, queryWork, totalWork, initializationGraphWork, maintenanceGraphWork, queryGraphWork, graphWork, primitiveWork, reconciled });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function statusMax(left: FrontierStatus, right: FrontierStatus): FrontierStatus {
  return STATUS_PRIORITY[left] >= STATUS_PRIORITY[right] ? left : right;
}

function assertId(id: string, name = "node id"): void {
  if (typeof id !== "string" || id.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

function assertFrontierStatus(status: unknown, name = "status"): asserts status is FrontierStatus {
  if (status !== "FRESH" && status !== "STALE" && status !== "INVALID" && status !== "UNKNOWN") {
    throw new TypeError(`${name} must be FRESH, STALE, INVALID, or UNKNOWN`);
  }
}

function assertDirtyStatus(status: unknown, name = "status"): asserts status is Exclude<FrontierStatus, "FRESH"> {
  assertFrontierStatus(status, name);
  if (status === "FRESH") throw new TypeError(`${name} cannot be FRESH for dirty propagation`);
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
  private readonly reachabilityCache = new Map<string, boolean>();
  private generation = 0;
  private graphRevision = 0;
  private trusted = true;
  private cacheInvalidations = 0;
  private cacheEntriesPreserved = 0;
  private lastCacheDelta = { invalidations: 0, preserved: 0 };
  private lastTraversal = { nodesVisited: 0, edgesTraversed: 0, branchesSkippedAlreadyDirty: 0, dirtyPropagations: 0 };
  private readonly counters: CounterBook = blankCounterBook();
  private phase: FrontierWorkPhase = "initialization";
  private frontierBudgetExceeded = false;
  private frontierComparisonBudgetUsed = 0;
  private frontierReachabilityWorkUsed = 0;
  private activeRootStateEntries = 0;
  private trustRecoveryRequired = false;

  constructor(nodes: readonly FrontierNode[] = []) {
    // Bulk-build the immutable initial graph. Calling setDependencies for
    // every node would clone the whole index and rebuild all dirty state on
    // each insertion, turning construction of a deep graph into O(V²).
    for (const node of nodes) {
      assertId(node.id);
      this.count("graphNodeLookups");
      const dependencies = unique(node.dependsOn ?? []);
      for (const dependencyId of dependencies) {
        assertId(dependencyId, "dependency id");
        this.count("graphNodeLookups");
        if (dependencyId === node.id) throw new Error(`Dependency cycle at ${node.id}`);
        if (!this.dependencies.has(dependencyId)) this.dependencies.set(dependencyId, new Set());
      }
      this.dependencies.set(node.id, new Set(dependencies));
    }
    for (const id of this.dependencies.keys()) this.dependents.set(id, new Set());
    for (const [id, dependencies] of this.dependencies) {
      this.count("graphNodeLookups");
      for (const dependencyId of dependencies) {
        this.count("graphEdgeTraversals");
        this.dependents.get(dependencyId)!.add(id);
      }
    }
    this.assertAcyclicGraph();
    this.graphRevision = nodes.length;
    this.generation = nodes.length;
    this.rebuildDirtyState();
    this.phase = "maintenance";
  }

  addNode(id: string, dependsOn: readonly string[] = []): void {
    assertId(id);
    if (this.dependencies.has(id)) throw new Error(`Node already exists: ${id}`);
    this.setDependencies(id, dependsOn);
  }

  setDependencies(id: string, dependsOn: readonly string[]): void {
    assertId(id);
    const next = unique(dependsOn);
    const previousDependencies = new Map([...this.dependencies].map(([nodeId, values]) => {
      this.count("graphNodeLookups");
      for (const _ of values) this.count("graphEdgeTraversals");
      return [nodeId, new Set(values)] as const;
    }));
    const previousDependents = new Map([...this.dependents].map(([nodeId, values]) => {
      this.count("graphNodeLookups");
      this.count("reverseIndexLookups");
      for (const _ of values) this.count("graphEdgeTraversals");
      return [nodeId, new Set(values)] as const;
    }));
    // Validate the complete dependency list before adding placeholders or
    // touching reverse edges. A later invalid item must not leave an earlier
    // unknown dependency behind after the call throws.
    for (const dependencyId of next) {
      assertId(dependencyId, "dependency id");
      if (dependencyId === id) throw new Error(`Dependency cycle at ${id}`);
    }
    for (const dependencyId of next) {
      this.count("graphNodeLookups");
      if (!this.dependencies.has(dependencyId)) this.dependencies.set(dependencyId, new Set());
    }
    if (this.dependencies.has(id)) this.removeReverseEdges(id);
    this.dependencies.set(id, new Set(next));
    for (const dependencyId of next) {
      this.count("graphNodeLookups");
      this.count("graphEdgeTraversals");
      this.count("reverseIndexLookups");
      const set = this.dependents.get(dependencyId) ?? new Set<string>();
      set.add(id);
      this.dependents.set(dependencyId, set);
    }
    try {
      this.assertAcyclic(id);
    } catch (error) {
      this.dependencies.clear();
      for (const [nodeId, values] of previousDependencies) {
        this.count("graphNodeLookups");
        for (const _ of values) this.count("graphEdgeTraversals");
        this.dependencies.set(nodeId, values);
      }
      this.dependents.clear();
      for (const [nodeId, values] of previousDependents) {
        this.count("graphNodeLookups");
        this.count("reverseIndexLookups");
        for (const _ of values) this.count("graphEdgeTraversals");
        this.dependents.set(nodeId, values);
      }
      throw error;
    }
    this.graphRevision += 1;
    this.clearReachabilityCache();
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
    this.clearReachabilityCache();
    this.generation += 1;
    this.rebuildDirtyState();
    this.invalidateAllCaches();
  }

  markDirty(nodeIds: readonly string[], status: Exclude<FrontierStatus, "FRESH"> = "STALE"): FrontierImpact {
    const previousPhase = this.enterPhase("maintenance");
    const before = this.captureCounters();
    try {
      assertDirtyStatus(status);
      const direct = unique(nodeIds);
      for (const id of direct) {
        assertId(id);
        this.count("graphNodeLookups");
        if (!this.dependencies.has(id)) throw new Error(`Unknown node: ${id}`);
      }
      this.beginFrontierOperation();
      this.generation += 1;
      for (const id of direct) {
        this.count("dirtyStateReads");
        const previous = this.directDirty.get(id);
        this.directDirty.set(id, previous === undefined ? status : statusMax(previous, status));
        this.count("dirtyStateWrites");
      }
      const impact = this.propagateDirty(direct.map((id) => [id, this.directDirty.get(id)!] as const));
      const cache = this.invalidateTargets(new Set(impact.affected));
      return Object.freeze({
        generation: this.generation,
        direct: Object.freeze(direct),
        ...impact,
        frontierCacheInvalidations: cache.invalidations,
        frontierCacheEntriesPreserved: cache.preserved,
        frontierComplete: this.trusted && !this.frontierBudgetExceeded,
        workBreakdown: this.workSince(before)
      });
    } finally {
      this.leavePhase(previousPhase);
    }
  }

  /**
   * Restore direct validity states from a persisted store in one propagation
   * pass. This keeps reconstruction work accounted for without replaying one
   * complete graph walk per record.
   */
  restoreStates(states: readonly Readonly<{ id: string; status: FrontierStatus }>[]): void {
    const previousPhase = this.enterPhase("maintenance");
    try {
      if (!Array.isArray(states)) throw new TypeError("states must be an array");
      const next = new Map<string, FrontierStatus>();
      for (const { id, status } of states) {
        assertId(id);
        assertFrontierStatus(status);
        this.count("graphNodeLookups");
        if (!this.dependencies.has(id)) throw new Error(`Unknown node: ${id}`);
        if (next.has(id)) throw new Error(`Duplicate state: ${id}`);
        if (status !== "FRESH") next.set(id, status);
      }
      if (states.length !== this.dependencies.size || [...this.dependencies.keys()].some((id) => !states.some((state) => state.id === id))) {
        throw new Error("Incomplete frontier state snapshot");
      }
      this.directDirty.clear();
      for (const [id, status] of next) {
        this.directDirty.set(id, status);
        this.count("dirtyStateWrites");
      }
      this.generation += 1;
      this.trustRecoveryRequired = false;
      this.trusted = true;
      this.rebuildDirtyState();
      if (this.frontierBudgetExceeded) this.trusted = false;
      this.invalidateAllCaches();
    } finally {
      this.leavePhase(previousPhase);
    }
  }

  /**
   * Replace a node's persisted validity state, allowing a fresh replacement
   * to remove an older INVALID/STALE root without relaxing other causes.
   */
  replaceStatus(nodeId: string, status: FrontierStatus): FrontierImpact {
    const previousPhase = this.enterPhase("maintenance");
    const before = this.captureCounters();
    try {
      assertFrontierStatus(status);
      assertId(nodeId);
      this.count("graphNodeLookups");
      if (!this.dependencies.has(nodeId)) throw new Error(`Unknown node: ${nodeId}`);
      const affected = this.descendantClosure(nodeId);
      const closureTraversal = { ...this.lastTraversal };
      const wasBudgetExceeded = this.frontierBudgetExceeded;
      this.directDirty.delete(nodeId);
      this.count("dirtyStateWrites");
      if (status !== "FRESH") {
        this.directDirty.set(nodeId, status);
        this.count("dirtyStateWrites");
      }
      this.generation += 1;
      if (wasBudgetExceeded) {
        this.trusted = false;
      } else {
        this.rebuildDirtyState();
        if (this.frontierBudgetExceeded) this.trusted = false;
      }
      const budgetExceeded = wasBudgetExceeded || this.frontierBudgetExceeded;
      const cache = budgetExceeded ? this.invalidateAllCaches() : this.invalidateTargets(affected);
      return Object.freeze({
        generation: this.generation,
        affected: Object.freeze([...affected].sort()),
        direct: Object.freeze([nodeId]),
        nodesVisited: closureTraversal.nodesVisited,
        edgesTraversed: closureTraversal.edgesTraversed,
        branchesSkippedAlreadyDirty: closureTraversal.branchesSkippedAlreadyDirty,
        dirtyPropagations: closureTraversal.dirtyPropagations,
        frontierCacheInvalidations: cache.invalidations,
        frontierCacheEntriesPreserved: cache.preserved,
        frontierComplete: this.trusted && !this.frontierBudgetExceeded,
        workBreakdown: this.workSince(before)
      });
    } finally {
      this.leavePhase(previousPhase);
    }
  }

  resolve(nodeId: string): FrontierImpact {
    const previousPhase = this.enterPhase("maintenance");
    const before = this.captureCounters();
    try {
      assertId(nodeId);
      this.count("graphNodeLookups");
      if (!this.dependencies.has(nodeId)) throw new Error(`Unknown node: ${nodeId}`);
      this.beginFrontierOperation();
      this.count("dirtyStateReads");
      const affected = [...(this.dirtyNodesByRoot.get(nodeId) ?? new Set([nodeId]))].sort();
      if (this.directDirty.get(nodeId) === "UNKNOWN") {
        this.trusted = false;
        this.trustRecoveryRequired = true;
        this.generation += 1;
        this.invalidateAllCaches();
        const impact = {
          generation: this.generation,
          affected: Object.freeze(affected),
          direct: Object.freeze([nodeId]),
          nodesVisited: affected.length,
          edgesTraversed: 0,
          branchesSkippedAlreadyDirty: 0,
          dirtyPropagations: 0
        };
        this.lastTraversal = {
          nodesVisited: impact.nodesVisited,
          edgesTraversed: impact.edgesTraversed,
          branchesSkippedAlreadyDirty: impact.branchesSkippedAlreadyDirty,
          dirtyPropagations: impact.dirtyPropagations
        };
        return Object.freeze({
          ...impact,
          frontierCacheInvalidations: 0,
          frontierCacheEntriesPreserved: 0,
          frontierComplete: false,
          workBreakdown: this.workSince(before)
        });
      }
      this.directDirty.delete(nodeId);
      this.count("dirtyStateWrites");
      this.dirtyNodesByRoot.delete(nodeId);
      for (const id of affected) {
        this.count("dirtyStateReads");
        const roots = this.activeDirtyRoots.get(id);
        if (roots === undefined) continue;
        if (roots.delete(nodeId)) this.activeRootStateEntries = Math.max(0, this.activeRootStateEntries - 1);
        this.count("dirtyStateWrites");
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
      const impact = {
        generation: this.generation,
        affected: Object.freeze(affected),
        direct: Object.freeze([nodeId]),
        nodesVisited: affected.length,
        edgesTraversed: 0,
        branchesSkippedAlreadyDirty: 0,
        dirtyPropagations: affected.length
      };
      this.lastTraversal = {
        nodesVisited: impact.nodesVisited,
        edgesTraversed: impact.edgesTraversed,
        branchesSkippedAlreadyDirty: impact.branchesSkippedAlreadyDirty,
        dirtyPropagations: impact.dirtyPropagations
      };
      const budgetExceeded = this.frontierBudgetExceeded;
      if (budgetExceeded) this.trusted = false;
      const cache = budgetExceeded ? this.invalidateAllCaches() : this.invalidateTargets(new Set(affected));
      return Object.freeze({ ...impact, frontierCacheInvalidations: cache.invalidations, frontierCacheEntriesPreserved: cache.preserved, frontierComplete: this.trusted && !this.frontierBudgetExceeded, workBreakdown: this.workSince(before) });
    } finally {
      this.leavePhase(previousPhase);
    }
  }

  markUnknown(): void {
    this.trusted = false;
    this.trustRecoveryRequired = true;
    this.generation += 1;
    this.invalidateAllCaches();
  }

  restoreTrust(): void {
    if (this.trustRecoveryRequired) {
      // An UNKNOWN signal is an explicit loss of authority. Rebuilding the
      // in-memory index alone cannot prove that the underlying observations
      // are current, so remain fail-closed until a complete snapshot is
      // supplied through restoreStates().
      this.invalidateAllCaches();
      return;
    }
    this.trusted = true;
    this.generation += 1;
    this.rebuildDirtyState();
    if (this.frontierBudgetExceeded) this.trusted = false;
    this.invalidateAllCaches();
  }

  frontier(nodeId: string): FrontierResult {
    const previousPhase = this.enterPhase("query");
    const before = this.captureCounters();
    try {
      assertId(nodeId);
      this.count("frontierLookups");
      this.count("graphNodeLookups");
      if (!this.dependencies.has(nodeId)) throw new Error(`Unknown node: ${nodeId}`);
      this.count("cacheLookups");
      const cached = this.frontierCache.get(nodeId);
      if (!this.frontierBudgetExceeded && cached?.graphRevision === this.graphRevision) {
        return Object.freeze({ ...cached.result, cacheHit: true, impactGeneration: this.generation, nodesVisited: 0, edgesTraversed: 0, workBreakdown: this.workSince(before) });
      }
      const impactGeneration = this.generation;
      if (!this.trusted || this.frontierBudgetExceeded) {
        this.count("cacheWrites");
        const result = Object.freeze({
          status: "UNKNOWN" as const,
          frontier: Object.freeze([]),
          complete: false,
          cacheHit: false,
          graphRevision: this.graphRevision,
          impactGeneration,
          nodesVisited: 0,
          edgesTraversed: 0,
          workBreakdown: this.workSince(before)
        });
        return this.cache(nodeId, result);
      }
      this.count("dirtyStateReads");
      const roots = this.activeDirtyRoots.get(nodeId);
      this.count("rootSetReads");
      const state = this.dirtyStates.get(nodeId);
      const status = roots === undefined
        ? "FRESH"
        : state?.graphRevision === this.graphRevision && state.generation === this.generation
          ? state.status
          : "UNKNOWN";
      if (roots !== undefined && status === "UNKNOWN") {
        this.trusted = false;
        this.invalidateAllCaches();
        this.count("cacheWrites");
        const result = Object.freeze({
          status: "UNKNOWN" as const,
          frontier: Object.freeze([]),
          complete: false,
          cacheHit: false,
          graphRevision: this.graphRevision,
          impactGeneration,
          nodesVisited: 1,
          edgesTraversed: 0,
          workBreakdown: this.workSince(before)
        });
        return this.cache(nodeId, result);
      }
      const frontier = this.activeFrontiers.get(nodeId) ?? new Set<string>();
      this.count("rootSetReads");
      this.count("cacheWrites");
      const result = Object.freeze({
        status,
        frontier: Object.freeze([...frontier].sort()),
        complete: true,
        cacheHit: false,
        graphRevision: this.graphRevision,
        impactGeneration,
        // The maintained index is a single lookup; the mutation paid for its
        // propagation separately. This is the O(F) query path.
        nodesVisited: 1,
        edgesTraversed: 0,
        workBreakdown: this.workSince(before)
      });
      return this.cache(nodeId, result);
    } finally {
      this.leavePhase(previousPhase);
    }
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
    reachabilityCacheEntries: number;
    reachabilityCacheLimit: number;
    reachabilityCacheAccountingReconciled: boolean;
    frontierBudgetExceeded: boolean;
    frontierRootComparisonBudget: number;
    frontierReachabilityWorkBudget: number;
    frontierReachabilityWorkUsed: number;
    activeRootStateEntries: number;
    activeRootStateEntryLimit: number;
    workBreakdown: FrontierWorkBreakdown;
  }> {
    const eligibleEntries = this.cacheInvalidations + this.cacheEntriesPreserved;
    const reachabilityCounters = COUNTER_KEYS.reduce((totals, key) => {
      if (key.startsWith("reachability")) totals[key] = this.counters.initialization[key] + this.counters.maintenance[key] + this.counters.query[key];
      return totals;
    }, {} as Partial<MutableCounters>);
    const reachabilityCacheAccountingReconciled = this.reachabilityCache.size
      === (reachabilityCounters.reachabilityCacheWrites ?? 0)
        - (reachabilityCounters.reachabilityCacheEvictions ?? 0)
        - (reachabilityCounters.reachabilityCacheEntriesCleared ?? 0)
      && reachabilityCounters.reachabilityQueries === reachabilityCounters.reachabilityCacheLookups
      && reachabilityCounters.reachabilityCacheLookups === (reachabilityCounters.reachabilityCacheHits ?? 0) + (reachabilityCounters.reachabilityCacheMisses ?? 0)
      && reachabilityCounters.reachabilityCacheMisses === (reachabilityCounters.reachabilityCacheWrites ?? 0) + (reachabilityCounters.reachabilityCacheWriteSkips ?? 0);
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
      cachePreservationRate: eligibleEntries === 0 ? null : this.cacheEntriesPreserved / eligibleEntries,
      reachabilityCacheEntries: this.reachabilityCache.size,
      reachabilityCacheLimit: MAX_REACHABILITY_CACHE_ENTRIES,
      reachabilityCacheAccountingReconciled,
      frontierBudgetExceeded: this.frontierBudgetExceeded,
      frontierRootComparisonBudget: MAX_FRONTIER_ROOT_COMPARISONS,
      frontierReachabilityWorkBudget: MAX_FRONTIER_REACHABILITY_WORK,
      frontierReachabilityWorkUsed: this.frontierReachabilityWorkUsed,
      activeRootStateEntries: this.activeRootStateEntries,
      activeRootStateEntryLimit: MAX_ACTIVE_ROOT_STATE_ENTRIES,
      workBreakdown: this.workSince(blankCounterBook())
    });
  }

  private captureCounters(): CounterBook {
    return {
      initialization: { ...this.counters.initialization },
      maintenance: { ...this.counters.maintenance },
      query: { ...this.counters.query }
    };
  }

  private workSince(before: CounterBook): FrontierWorkBreakdown {
    return workBreakdown(before, this.counters);
  }

  private count(key: CounterKey, amount = 1): void {
    this.counters[this.phase][key] += amount;
  }

  private beginFrontierOperation(): void {
    if (!this.frontierBudgetExceeded) {
      this.frontierComparisonBudgetUsed = 0;
      this.frontierReachabilityWorkUsed = 0;
    }
  }

  private enterPhase(phase: FrontierWorkPhase): FrontierWorkPhase {
    const previous = this.phase;
    this.phase = phase;
    return previous;
  }

  private leavePhase(previous: FrontierWorkPhase): void {
    this.phase = previous;
  }

  private cache(nodeId: string, result: FrontierResult): FrontierResult {
    this.frontierCache.set(nodeId, { graphRevision: this.graphRevision, result });
    return result;
  }

  private propagateDirty(seeds: readonly (readonly [string, FrontierStatus])[]): Omit<FrontierImpact, "generation" | "direct" | "frontierCacheInvalidations" | "frontierCacheEntriesPreserved" | "frontierComplete" | "workBreakdown"> {
    let nodesVisited = 0;
    let edgesTraversed = 0;
    let branchesSkippedAlreadyDirty = 0;
    let dirtyPropagations = 0;
    const affected = new Set<string>();
    const queue: Array<readonly [string, ReadonlyMap<string, FrontierStatus>]> = [];
    const frontierRefreshes = new Set<string>();
    const generationRefreshes = new Set<string>();
    for (const [id, value] of seeds) {
      if (this.frontierBudgetExceeded) break;
      affected.add(id);
      const roots = new Map([[id, value]]);
      this.count("dirtyStateReads");
      if (this.mergeDirtyState(id, roots)) {
        queue.push([id, this.activeDirtyRoots.get(id)!]);
        frontierRefreshes.add(id);
      } else {
        // The complete affected set is already indexed by root. Reporting
        // the skipped downstream branches does not require walking them.
        const knownNodes = this.dirtyNodesByRoot.get(id) ?? new Set([id]);
        branchesSkippedAlreadyDirty += Math.max(0, knownNodes.size - 1);
        for (const knownNode of knownNodes) generationRefreshes.add(knownNode);
      }
      this.count("reverseIndexLookups");
      for (const known of this.dirtyNodesByRoot.get(id) ?? []) affected.add(known);
    }
    for (let index = 0; index < queue.length; index += 1) {
      if (this.frontierBudgetExceeded) break;
      const [id, roots] = queue[index]!;
      nodesVisited += 1;
      this.count("graphNodeLookups");
      this.count("reverseIndexLookups");
      for (const dependent of [...(this.dependents.get(id) ?? [])].sort()) {
        if (this.frontierBudgetExceeded) break;
        edgesTraversed += 1;
        this.count("graphEdgeTraversals");
        this.count("graphNodeLookups");
        for (const affectedRoot of roots.keys()) affected.add(dependent);
        const changed = this.mergeDirtyState(dependent, roots);
        if (!changed) {
          // The dependent already contains every incoming root at an equal or
          // stronger severity for this graph revision. No branch traversal is
          // needed for this generation.
          branchesSkippedAlreadyDirty += 1;
          for (const root of roots.keys()) {
            for (const knownNode of this.dirtyNodesByRoot.get(root) ?? []) {
              generationRefreshes.add(knownNode);
            }
          }
          continue;
        }
        dirtyPropagations += 1;
        queue.push([dependent, this.activeDirtyRoots.get(dependent)!]);
        frontierRefreshes.add(dependent);
      }
    }
    if (!this.frontierBudgetExceeded) {
      for (const nodeId of frontierRefreshes) this.refreshFrontier(nodeId);
      for (const nodeId of generationRefreshes) {
        if (!frontierRefreshes.has(nodeId) && this.activeDirtyRoots.has(nodeId)) this.updateDirtyState(nodeId);
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
    this.count("dirtyStateReads");
    const roots = this.activeDirtyRoots.get(nodeId) ?? new Map<string, FrontierStatus>();
    let additionalEntries = 0;
    for (const root of incoming.keys()) if (!roots.has(root)) additionalEntries += 1;
    if (this.activeRootStateEntries + additionalEntries > MAX_ACTIVE_ROOT_STATE_ENTRIES) {
      this.frontierBudgetExceeded = true;
      return false;
    }
    let changed = false;
    for (const [root, status] of incoming) {
      this.count("rootSetReads");
      const previous = roots.get(root);
      if (previous !== undefined && STATUS_PRIORITY[previous] >= STATUS_PRIORITY[status]) continue;
      roots.set(root, status);
      changed = true;
      if (previous === undefined) this.activeRootStateEntries += 1;
      const nodes = this.dirtyNodesByRoot.get(root) ?? new Set<string>();
      nodes.add(nodeId);
      this.dirtyNodesByRoot.set(root, nodes);
      this.count("dirtyStateWrites");
    }
    if (!changed) {
      // The operation generation advances even when a repeated root carries
      // no stronger information. Refresh the maintained snapshot so a safe
      // query does not mistake unchanged dirty state for stale index state.
      this.updateDirtyState(nodeId);
      return false;
    }
    this.activeDirtyRoots.set(nodeId, roots);
    this.count("dirtyStateWrites");
    this.count("rootSetWrites");
    return true;
  }

  /**
   * Rebuild a node's antichain after propagation has materialized every
   * causal root at its own node. For a direct root R, activeDirtyRoots[R]
   * contains exactly the direct roots that can reach R. That relation is
   * already the proof needed for antichain dominance, so no second BFS is
   * required. This is deliberately run only after the propagation queue has
   * drained; before then, absence of an ancestor would not yet be evidence of
   * non-reachability.
   */
  private refreshFrontier(nodeId: string): void {
    const roots = this.activeDirtyRoots.get(nodeId);
    if (roots === undefined) return;
    const rootIds = new Set(roots.keys());
    const frontier = new Set<string>();
    for (const root of rootIds) {
      const causalRoots = this.activeDirtyRoots.get(root);
      if (causalRoots === undefined) {
        this.frontierBudgetExceeded = true;
        return;
      }
      this.count("frontierRootComparisons");
      this.frontierComparisonBudgetUsed += 1;
      if (this.frontierComparisonBudgetUsed > MAX_FRONTIER_ROOT_COMPARISONS) {
        this.frontierBudgetExceeded = true;
        return;
      }
      let dominated = false;
      for (const ancestor of causalRoots.keys()) {
        if (ancestor === root) continue;
        this.count("rootSetReads");
        if (rootIds.has(ancestor)) {
          dominated = true;
          break;
        }
      }
      if (!dominated) frontier.add(root);
    }
    this.activeFrontiers.set(nodeId, frontier);
    this.count("rootSetWrites");
    this.updateDirtyState(nodeId);
  }

  private updateDirtyState(nodeId: string): void {
    this.count("dirtyStateReads");
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
    this.count("dirtyStateWrites");
  }

  private addFrontierRoot(frontier: Set<string>, root: string): void {
    if (this.frontierBudgetExceeded) return;
    for (const existing of [...frontier]) {
      if (this.frontierComparisonBudgetUsed >= MAX_FRONTIER_ROOT_COMPARISONS) {
        this.frontierBudgetExceeded = true;
        return;
      }
      this.count("frontierRootComparisons");
      this.frontierComparisonBudgetUsed += 1;
      if (existing === root || this.reaches(existing, root)) return;
      if (this.frontierBudgetExceeded) return;
      if (this.reaches(root, existing)) frontier.delete(existing);
      if (this.frontierBudgetExceeded) return;
    }
    frontier.add(root);
  }

  private computeFrontier(roots: Iterable<string>): Set<string> {
    const rootIds = new Set(roots);
    const result = new Set<string>();
    for (const root of rootIds) {
      const causalRoots = this.activeDirtyRoots.get(root);
      if (causalRoots === undefined) {
        for (const fallback of rootIds) this.addFrontierRoot(result, fallback);
        return result;
      }
      this.count("frontierRootComparisons");
      this.frontierComparisonBudgetUsed += 1;
      if (this.frontierComparisonBudgetUsed > MAX_FRONTIER_ROOT_COMPARISONS) {
        this.frontierBudgetExceeded = true;
        return new Set();
      }
      const dominated = [...causalRoots.keys()].some((ancestor) => {
        if (ancestor === root) return false;
        this.count("rootSetReads");
        return rootIds.has(ancestor);
      });
      if (!dominated) result.add(root);
    }
    return result;
  }

  private rebuildDirtyState(): void {
    this.frontierBudgetExceeded = false;
    this.frontierComparisonBudgetUsed = 0;
    this.frontierReachabilityWorkUsed = 0;
    this.activeRootStateEntries = 0;
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
      this.count("cacheEntriesScanned");
      if (targets.has(nodeId)) {
        this.frontierCache.delete(nodeId);
        this.cacheInvalidations += 1;
        this.count("cacheInvalidations");
        invalidations += 1;
      } else {
        this.cacheEntriesPreserved += 1;
        this.count("cacheEntriesPreserved");
        preserved += 1;
      }
    }
    this.lastCacheDelta = { invalidations, preserved };
    return this.lastCacheDelta;
  }

  private invalidateAllCaches(): { invalidations: number; preserved: number } {
    const invalidations = this.frontierCache.size;
    this.cacheInvalidations += invalidations;
    this.count("cacheEntriesScanned", invalidations);
    this.count("cacheInvalidations", invalidations);
    this.frontierCache.clear();
    this.lastCacheDelta = { invalidations, preserved: 0 };
    return this.lastCacheDelta;
  }

  private reaches(start: string, target: string): boolean {
    this.count("reachabilityQueries");
    this.count("reachabilityCacheLookups");
    // JSON encodes the pair structurally. IDs are protocol data and may
    // contain NULs or delimiter-looking text, so string concatenation is not
    // a safe cache-key format.
    const key = JSON.stringify([start, target]);
    const cached = this.reachabilityCache.get(key);
    if (cached !== undefined) {
      this.count("reachabilityCacheHits");
      return cached;
    }
    this.count("reachabilityCacheMisses");
    const seen = new Set<string>();
    const queue = [start];
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index]!;
      this.count("reachabilityNodesVisited");
      this.frontierReachabilityWorkUsed += 1;
      if (this.frontierReachabilityWorkUsed > MAX_FRONTIER_REACHABILITY_WORK) {
        this.frontierBudgetExceeded = true;
        this.count("reachabilityCacheWriteSkips");
        return false;
      }
      this.count("reverseIndexLookups");
      for (const dependent of this.dependents.get(id) ?? []) {
        this.count("reachabilityEdgesTraversed");
        this.frontierReachabilityWorkUsed += 1;
        if (this.frontierReachabilityWorkUsed > MAX_FRONTIER_REACHABILITY_WORK) {
          this.frontierBudgetExceeded = true;
          this.count("reachabilityCacheWriteSkips");
          return false;
        }
        if (dependent === target) {
          this.rememberReachability(key, true);
          return true;
        }
        if (seen.has(dependent)) continue;
        seen.add(dependent);
        queue.push(dependent);
      }
    }
    this.rememberReachability(key, false);
    return false;
  }

  private rememberReachability(key: string, value: boolean): void {
    if (!this.reachabilityCache.has(key) && this.reachabilityCache.size >= MAX_REACHABILITY_CACHE_ENTRIES) {
      const oldest = this.reachabilityCache.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        this.reachabilityCache.delete(oldest);
        this.count("reachabilityCacheEvictions");
      }
    }
    this.reachabilityCache.set(key, value);
    this.count("reachabilityCacheWrites");
  }

  private clearReachabilityCache(): void {
    if (this.reachabilityCache.size > 0) {
      this.count("reachabilityCacheEntriesCleared", this.reachabilityCache.size);
      this.reachabilityCache.clear();
    }
  }

  private removeReverseEdges(id: string): void {
    this.count("graphNodeLookups");
    for (const dependencyId of this.dependencies.get(id) ?? []) {
      this.count("graphNodeLookups");
      this.count("graphEdgeTraversals");
      this.count("reverseIndexLookups");
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
      this.count("graphNodeLookups");
      const dependencies = [...(this.dependencies.get(frame.id) ?? [])].reverse();
      for (const dependencyId of dependencies) {
        this.count("graphEdgeTraversals");
        if (visiting.has(dependencyId)) throw new Error(`Dependency cycle at ${dependencyId}`);
        if (!visited.has(dependencyId)) {
          this.count("graphNodeLookups");
          stack.push({ id: dependencyId, exit: false });
        }
      }
    }
  }

  private descendantClosure(start: string): Set<string> {
    const affected = new Set([start]);
    const queue = [start];
    let nodesVisited = 0;
    let edgesTraversed = 0;
    for (let index = 0; index < queue.length; index += 1) {
      nodesVisited += 1;
      this.count("graphNodeLookups");
      this.count("reverseIndexLookups");
      for (const dependent of this.dependents.get(queue[index]!) ?? []) {
        edgesTraversed += 1;
        this.count("graphEdgeTraversals");
        if (affected.has(dependent)) continue;
        affected.add(dependent);
        queue.push(dependent);
      }
    }
    this.lastTraversal = { nodesVisited, edgesTraversed, branchesSkippedAlreadyDirty: 0, dirtyPropagations: affected.size };
    return affected;
  }

  private assertAcyclicGraph(): void {
    const state = new Map<string, 0 | 1 | 2>();
    for (const start of this.dependencies.keys()) {
      if (state.get(start) === 2) continue;
      state.set(start, 1);
      this.count("graphNodeLookups");
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
        this.count("graphEdgeTraversals");
        const dependencyState = state.get(dependencyId) ?? 0;
        if (dependencyState === 1) throw new Error(`Dependency cycle at ${dependencyId}`);
        if (dependencyState === 2) continue;
        state.set(dependencyId, 1);
        this.count("graphNodeLookups");
        stack.push({ id: dependencyId, dependencies: [...(this.dependencies.get(dependencyId) ?? [])], index: 0 });
      }
    }
  }
}
