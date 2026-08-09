export class DependencyCycleError extends Error {
  readonly nodeId: string;
  readonly dependencyId: string;

  constructor(nodeId: string, dependencyId: string) {
    super(`Adding ${nodeId} -> ${dependencyId} would create a dependency cycle`);
    this.name = "DependencyCycleError";
    this.nodeId = nodeId;
    this.dependencyId = dependencyId;
  }
}

export class DependencyGraph {
  private readonly dependencies = new Map<string, Set<string>>();
  private readonly dependents = new Map<string, Set<string>>();

  addNode(nodeId: string): void {
    if (!nodeId) throw new TypeError("nodeId must be non-empty");
    if (!this.dependencies.has(nodeId)) this.dependencies.set(nodeId, new Set());
    if (!this.dependents.has(nodeId)) this.dependents.set(nodeId, new Set());
  }

  hasNode(nodeId: string): boolean {
    return this.dependencies.has(nodeId);
  }

  addDependency(nodeId: string, dependencyId: string): void {
    const nodeWasKnown = this.dependencies.has(nodeId);
    this.addNode(nodeId);
    this.addNode(dependencyId);
    if (nodeId === dependencyId || (nodeWasKnown && this.hasPath(dependencyId, nodeId))) throw new DependencyCycleError(nodeId, dependencyId);
    const deps = this.dependencies.get(nodeId)!;
    if (deps.has(dependencyId)) return;
    deps.add(dependencyId);
    this.dependents.get(dependencyId)!.add(nodeId);
  }

  setDependencies(nodeId: string, dependencyIds: readonly string[]): void {
    const nodeWasKnown = this.dependencies.has(nodeId);
    this.addNode(nodeId);
    const next = [...new Set(dependencyIds)].sort();
    for (const dependencyId of next) {
      if (typeof dependencyId !== "string" || dependencyId.length === 0) throw new TypeError("dependencyId must be non-empty");
      if (nodeId === dependencyId || (nodeWasKnown && this.hasPath(dependencyId, nodeId))) throw new DependencyCycleError(nodeId, dependencyId);
    }
    for (const oldDependency of this.dependencies.get(nodeId)!) this.dependents.get(oldDependency)?.delete(nodeId);
    this.dependencies.get(nodeId)!.clear();
    for (const dependencyId of next) {
      this.addNode(dependencyId);
      this.dependencies.get(nodeId)!.add(dependencyId);
      this.dependents.get(dependencyId)!.add(nodeId);
    }
  }

  dependenciesOf(nodeId: string): readonly string[] {
    return [...(this.dependencies.get(nodeId) ?? [])].sort();
  }

  dependentsOf(nodeId: string): readonly string[] {
    return [...(this.dependents.get(nodeId) ?? [])].sort();
  }

  forEachDependency(nodeId: string, visit: (dependencyId: string) => void): void {
    for (const dependencyId of this.dependencies.get(nodeId) ?? []) visit(dependencyId);
  }

  forEachDependent(nodeId: string, visit: (dependentId: string) => void): void {
    for (const dependentId of this.dependents.get(nodeId) ?? []) visit(dependentId);
  }

  reachableDependents(nodeId: string): readonly string[] {
    const visited = new Set<string>();
    const queue = [...this.dependentsOf(nodeId)];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      queue.push(...this.dependentsOf(current));
    }
    return [...visited].sort();
  }

  topologicalOrder(): readonly string[] {
    const inDegree = new Map<string, number>();
    for (const node of this.dependencies.keys()) inDegree.set(node, this.dependencies.get(node)!.size);
    const queue = [...inDegree.entries()].filter(([, degree]) => degree === 0).map(([node]) => node).sort();
    const result: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      result.push(node);
      for (const dependent of this.dependentsOf(node)) {
        const degree = inDegree.get(dependent)! - 1;
        inDegree.set(dependent, degree);
        if (degree === 0) queue.push(dependent);
      }
      queue.sort();
    }
    if (result.length !== inDegree.size) throw new Error("Dependency graph contains a cycle");
    return result;
  }

  private hasPath(start: string, target: string): boolean {
    const visited = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      stack.push(...this.dependenciesOf(current));
    }
    return false;
  }
}
