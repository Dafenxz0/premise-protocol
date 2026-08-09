import type { MemoryEnvelope } from "@premise/protocol-types";

export class DeterministicClock {
  private current: number;
  constructor(start = "2026-08-09T00:00:00.000Z") { this.current = Date.parse(start); if (Number.isNaN(this.current)) throw new Error("Invalid clock start"); }
  now(): string { return new Date(this.current).toISOString(); }
  advance(milliseconds: number): string { if (!Number.isFinite(milliseconds)) throw new Error("milliseconds must be finite"); this.current += milliseconds; return this.now(); }
  set(instant: string): void { const parsed = Date.parse(instant); if (Number.isNaN(parsed)) throw new Error("Invalid clock instant"); this.current = parsed; }
}

export class SeededRandom {
  private state: number;
  constructor(seed = 1) { this.state = (seed >>> 0) || 1; }
  next(): number { this.state = (1664525 * this.state + 1013904223) >>> 0; return this.state / 0x100000000; }
  integer(maxExclusive: number): number { return Math.floor(this.next() * maxExclusive); }
}

export function generateMemoryEnvelope(index: number, clock = new DeterministicClock()): MemoryEnvelope {
  const memoryId = `memory:test-${index}`;
  return { specVersion: "premise/0.1", memoryId, provenance: [{ sourceUri: `test://${index}`, observedAt: clock.now(), version: { scheme: "test", token: "v1" }, validator: { id: "test", operation: "read" } }], validity: { status: "FRESH", checkedAt: clock.now(), policy: "VERSIONED" }, dependsOn: [] };
}

export function assertAcyclic(edges: Readonly<Record<string, readonly string[]>>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) throw new Error(`cycle at ${node}`);
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dependency of edges[node] ?? []) visit(dependency);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of Object.keys(edges).sort()) visit(node);
}

export function runProperties(properties: Readonly<Record<string, () => void>>): { readonly passed: number; readonly failed: readonly string[] } {
  const failed: string[] = [];
  for (const [name, property] of Object.entries(properties)) { try { property(); } catch (error) { failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); } }
  return { passed: Object.keys(properties).length - failed.length, failed };
}
