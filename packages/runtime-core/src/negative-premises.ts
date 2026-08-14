import { createHash } from "node:crypto";

export const NEGATIVE_PREMISE_SPEC_VERSION = "premise-negative/1" as const;
export type NegativePremiseState = "ABSENT" | "STALE" | "UNKNOWN";
export type NegativePremiseDecision = "USE" | "REVALIDATE" | "REJECT";

export interface NegativePremiseIdentity {
  readonly tenantId: string;
  readonly resource: string;
  readonly incarnationId: string;
  readonly queryDigest: string;
  readonly frontierDigest: string;
  readonly authorizationContextDigest: string;
}

export interface NegativePremise extends NegativePremiseIdentity {
  readonly specVersion: typeof NEGATIVE_PREMISE_SPEC_VERSION;
  readonly state: "ABSENT";
  readonly reason: string;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface NegativePremiseCheck {
  readonly state: NegativePremiseState;
  readonly decision: NegativePremiseDecision;
  readonly reason: "ABSENT" | "NOT_FOUND" | "EXPIRED" | "FRONTIER_CHANGED" | "ENTITY_PRESENT" | "INCARNATION_CHANGED" | "INVALID_SCOPE";
}

export interface NegativePremiseStats {
  readonly hits: number;
  readonly misses: number;
  readonly expirations: number;
  readonly evictions: number;
  readonly entries: number;
  readonly peakEntries: number;
}

interface StoredNegativePremise extends NegativePremise {
  readonly key: string;
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function timestamp(value: unknown, name: string): string {
  const text = required(value, name);
  if (Number.isNaN(Date.parse(text))) throw new TypeError(`${name} must be an ISO timestamp`);
  return text;
}

function assertScope(scope: NegativePremiseIdentity): void {
  required(scope.tenantId, "tenantId");
  required(scope.resource, "resource");
  required(scope.incarnationId, "incarnationId");
  required(scope.queryDigest, "queryDigest");
  required(scope.frontierDigest, "frontierDigest");
  required(scope.authorizationContextDigest, "authorizationContextDigest");
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  throw new TypeError("negative premise scope must be JSON serializable");
}

export function negativePremiseKey(scope: NegativePremiseIdentity): string {
  assertScope(scope);
  return `sha256:${createHash("sha256").update(canonical({ domain: NEGATIVE_PREMISE_SPEC_VERSION, ...scope }), "utf8").digest("hex")}`;
}

function decision(state: NegativePremiseState): NegativePremiseDecision {
  return state === "ABSENT" ? "USE" : state === "STALE" ? "REVALIDATE" : "REJECT";
}

function check(state: NegativePremiseState, reason: NegativePremiseCheck["reason"]): NegativePremiseCheck {
  return Object.freeze({ state, decision: decision(state), reason });
}

/**
 * Bounded store for absence observations. Eviction removes knowledge; it can
 * never manufacture a fresh negative fact. This module does not query a
 * source, so callers must supply an authoritative presence/frontier signal.
 */
export class NegativePremiseStore {
  private readonly entries = new Map<string, StoredNegativePremise>();
  private readonly maxEntries: number;
  private readonly maxEntriesPerTenant: number | undefined;
  private readonly tenantCounts = new Map<string, number>();
  private hits = 0;
  private misses = 0;
  private expirations = 0;
  private evictions = 0;
  private peakEntries = 0;

  constructor(options: { readonly maxEntries?: number; readonly maxEntriesPerTenant?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 1024;
    this.maxEntriesPerTenant = options.maxEntriesPerTenant;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) throw new RangeError("maxEntries must be a positive integer");
    if (this.maxEntriesPerTenant !== undefined && (!Number.isSafeInteger(this.maxEntriesPerTenant) || this.maxEntriesPerTenant < 1)) {
      throw new RangeError("maxEntriesPerTenant must be a positive integer");
    }
  }

  putAbsent(input: Omit<NegativePremise, "specVersion" | "state">): string {
    assertScope(input);
    const observedAt = timestamp(input.observedAt, "observedAt");
    const expiresAt = timestamp(input.expiresAt, "expiresAt");
    required(input.reason, "reason");
    if (Date.parse(expiresAt) <= Date.parse(observedAt)) throw new RangeError("expiresAt must be after observedAt");
    const premise: NegativePremise = Object.freeze({ ...input, specVersion: NEGATIVE_PREMISE_SPEC_VERSION, state: "ABSENT" });
    const key = negativePremiseKey({
      tenantId: premise.tenantId,
      resource: premise.resource,
      incarnationId: premise.incarnationId,
      queryDigest: premise.queryDigest,
      frontierDigest: premise.frontierDigest,
      authorizationContextDigest: premise.authorizationContextDigest
    });
    this.remove(key);
    this.entries.set(key, { ...premise, key });
    this.tenantCounts.set(premise.tenantId, (this.tenantCounts.get(premise.tenantId) ?? 0) + 1);
    this.peakEntries = Math.max(this.peakEntries, this.entries.size);
    while (this.entries.size > this.maxEntries) this.evictOldest();
    if (this.maxEntriesPerTenant !== undefined) {
      while ((this.tenantCounts.get(premise.tenantId) ?? 0) > this.maxEntriesPerTenant) this.evictOldest(premise.tenantId);
    }
    return key;
  }

  check(scope: NegativePremiseIdentity, now: string, observation: { readonly entityPresent?: boolean; readonly frontierDigest?: string; readonly incarnationId?: string } = {}): NegativePremiseCheck {
    try { assertScope(scope); timestamp(now, "now"); } catch { this.misses += 1; return check("UNKNOWN", "INVALID_SCOPE"); }
    const key = negativePremiseKey(scope);
    const entry = this.entries.get(key);
    if (entry === undefined) { this.misses += 1; return check("UNKNOWN", "NOT_FOUND"); }
    if (Date.parse(now) >= Date.parse(entry.expiresAt)) { this.remove(key); this.expirations += 1; this.misses += 1; return check("UNKNOWN", "EXPIRED"); }
    if (observation.incarnationId !== undefined && observation.incarnationId !== entry.incarnationId) {
      this.hits += 1;
      return check("STALE", "INCARNATION_CHANGED");
    }
    if (observation.frontierDigest !== undefined && observation.frontierDigest !== entry.frontierDigest) {
      this.hits += 1;
      return check("STALE", "FRONTIER_CHANGED");
    }
    if (observation.entityPresent === true) {
      this.hits += 1;
      return check("STALE", "ENTITY_PRESENT");
    }
    this.hits += 1;
    return check("ABSENT", "ABSENT");
  }

  invalidateOnAppearance(scope: Pick<NegativePremiseIdentity, "tenantId" | "resource" | "incarnationId">): number {
    required(scope.tenantId, "tenantId");
    required(scope.resource, "resource");
    required(scope.incarnationId, "incarnationId");
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.tenantId === scope.tenantId && entry.resource === scope.resource && entry.incarnationId === scope.incarnationId) {
        if (this.remove(key)) removed += 1;
      }
    }
    return removed;
  }

  clear(): void { this.entries.clear(); this.tenantCounts.clear(); }

  stats(): NegativePremiseStats {
    return Object.freeze({ hits: this.hits, misses: this.misses, expirations: this.expirations, evictions: this.evictions, entries: this.entries.size, peakEntries: this.peakEntries });
  }

  private remove(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    this.entries.delete(key);
    const count = this.tenantCounts.get(entry.tenantId) ?? 0;
    if (count <= 1) this.tenantCounts.delete(entry.tenantId);
    else this.tenantCounts.set(entry.tenantId, count - 1);
    return true;
  }

  private evictOldest(tenantId?: string): void {
    for (const [key, entry] of this.entries) {
      if (tenantId === undefined || entry.tenantId === tenantId) {
        this.remove(key);
        this.evictions += 1;
        return;
      }
    }
  }
}
