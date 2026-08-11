export type ContextKind = "summary" | "detail";
export type FreshnessStatus = "FRESH" | "STALE" | "INVALID" | "UNKNOWN";
export type FreshnessInput = FreshnessStatus | "OBSOLETE";
export type TokenEstimator = (text: string) => number;

export const defaultTokenEstimator: TokenEstimator = (text) => {
  const length = Array.from(text.trim()).length;
  return length === 0 ? 0 : Math.max(1, Math.ceil(length / 4));
};

export const estimateTokens = defaultTokenEstimator;

export interface ContextInputChunk {
  readonly id?: string;
  readonly text?: string;
  readonly content?: string;
  readonly tokenCount?: number;
  readonly tokens?: number;
  readonly kind?: ContextKind;
  readonly parentId?: string;
  readonly dedupeKey?: string;
}

export interface ContextCandidate {
  readonly id: string;
  readonly text?: string;
  readonly content?: string;
  readonly summary?: string;
  readonly chunks?: readonly (string | ContextInputChunk)[];
  readonly kind?: ContextKind;
  readonly parentId?: string;
  readonly topic?: string;
  readonly groupId?: string;
  readonly score?: number;
  readonly relevance?: number;
  readonly priority?: number;
  readonly recency?: number;
  readonly freshness?: FreshnessInput;
  readonly status?: FreshnessInput;
  readonly observedAt?: string | number | Date;
  readonly expiresAt?: string | number | Date;
  readonly tokenCount?: number;
  readonly tokens?: number;
  readonly dedupeKey?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface FreshnessGate {
  readonly allowStale?: boolean;
  readonly allowStaleSummaries?: boolean;
  readonly allowUnknown?: boolean;
  readonly maxAgeMs?: number;
  readonly now?: string | number | Date;
}

export interface ContextEngineOptions {
  readonly tokenEstimator?: TokenEstimator;
  readonly chunkSizeTokens?: number;
  readonly freshnessGate?: FreshnessGate;
  readonly diversityWeight?: number;
}

export interface ContextSelectionRequest {
  readonly candidates?: readonly ContextCandidate[];
  readonly items?: readonly ContextCandidate[];
  readonly memories?: readonly ContextCandidate[];
  readonly tokenBudget?: number;
  readonly budget?: number;
  readonly reservedTokens?: number;
  readonly chunkSizeTokens?: number;
  readonly maxChunks?: number;
  readonly maxSources?: number;
  readonly diversityWeight?: number;
  readonly freshnessGate?: FreshnessGate;
  readonly now?: string | number | Date;
  readonly tokenEstimator?: TokenEstimator;
}

export type SelectionSkipReason =
  | "empty"
  | "stale"
  | "expired"
  | "unknown-freshness"
  | "invalid-freshness"
  | "duplicate"
  | "budget"
  | "parent-not-selected"
  | "parent-missing"
  | "hierarchy-cycle"
  | "max-chunks"
  | "max-sources";

export type SelectionReason = "selected" | SelectionSkipReason;

export type DegradationReason = "token-budget" | "freshness-gate" | "deduplication" | "hierarchy" | "limits";

export interface SelectionTraceEntry {
  readonly id: string;
  readonly sourceId: string;
  readonly memoryId: string;
  readonly decision: "selected" | "skipped";
  readonly reason: SelectionReason;
  readonly tokens: number;
  readonly kind: ContextKind;
  readonly topic: string;
  readonly freshness: FreshnessStatus;
  readonly score: number;
  readonly phase: number;
  readonly parentId?: string;
  readonly duplicateOf?: string;
  readonly order?: number;
}

export interface SelectedContextChunk {
  readonly id: string;
  readonly sourceId: string;
  readonly memoryId: string;
  readonly text: string;
  readonly content: string;
  readonly tokens: number;
  readonly kind: ContextKind;
  readonly topic: string;
  readonly freshness: FreshnessStatus;
  readonly score: number;
  readonly order: number;
  readonly parentId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ContextSelectionStats {
  readonly candidateCount: number;
  readonly sourceCount: number;
  readonly chunkCount: number;
  readonly selectedChunkCount: number;
  readonly selectedSourceCount: number;
  readonly selectedTopicCount: number;
}

export interface ContextSelectionResult {
  readonly selected: readonly SelectedContextChunk[];
  readonly trace: readonly SelectionTraceEntry[];
  readonly omitted: readonly SelectionTraceEntry[];
  readonly tokenBudget: number;
  readonly usableTokenBudget: number;
  readonly reservedTokens: number;
  readonly tokensUsed: number;
  readonly remainingTokens: number;
  readonly degraded: boolean;
  readonly degradationReasons: readonly DegradationReason[];
  readonly stats: ContextSelectionStats;
}

interface RawSegment {
  readonly requestedId: string | undefined;
  readonly text: string;
  readonly tokenCount: number | undefined;
  readonly kind: ContextKind | undefined;
  readonly parentId: string | undefined;
  readonly dedupeKey: string | undefined;
}

interface SourceDescriptor {
  readonly sourceId: string;
  readonly memoryId: string;
  readonly kind: ContextKind;
  readonly parentId: string | undefined;
  readonly topic: string;
  readonly score: number;
  readonly freshness: FreshnessStatus;
  readonly observedAt: string | number | Date | undefined;
  readonly expiresAt: string | number | Date | undefined;
  readonly dedupeKey: string | undefined;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
  readonly segments: readonly RawSegment[];
}

interface Unit {
  readonly id: string;
  readonly sourceId: string;
  readonly memoryId: string;
  readonly text: string;
  readonly tokens: number;
  readonly kind: ContextKind;
  readonly parentId: string | undefined;
  readonly topic: string;
  freshness: FreshnessStatus;
  readonly score: number;
  readonly dedupeKey: string;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
  readonly ordinal: number;
  depth: number;
  phase: number;
  hierarchyIssue: "parent-missing" | "hierarchy-cycle" | undefined;
}

interface InternalTrace {
  readonly unit: Unit;
  decision: "pending" | "selected" | "skipped";
  reason: SelectionReason | "pending";
  duplicateOf: string | undefined;
  order: number | undefined;
}

interface HierarchyInfo {
  readonly depth: number;
  readonly issue: "parent-missing" | "hierarchy-cycle" | undefined;
}

type TimeValue = string | number | Date;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
}

function nonEmptyId(value: unknown, label: string): string {
  assertString(value, label);
  if (value.trim().length === 0) throw new TypeError(`${label} must not be empty`);
  return value;
}

function normalizedKind(value: unknown, label: string): ContextKind {
  if (value === undefined) return "detail";
  if (value !== "summary" && value !== "detail") throw new TypeError(`${label} must be summary or detail`);
  return value;
}

function normalizedFreshness(value: unknown, label: string): FreshnessStatus {
  if (value === undefined) return "FRESH";
  if (value === "OBSOLETE") return "STALE";
  if (value !== "FRESH" && value !== "STALE" && value !== "INVALID" && value !== "UNKNOWN") {
    throw new TypeError(`${label} must be FRESH, STALE, INVALID, UNKNOWN, or OBSOLETE`);
  }
  return value;
}

function normalizedText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  assertString(value, label);
  return value;
}

function textFrom(value: { readonly text?: string; readonly content?: string }, label: string): string | undefined {
  const text = normalizedText(value.text, `${label}.text`);
  const content = normalizedText(value.content, `${label}.content`);
  if (text !== undefined && content !== undefined && text !== content) throw new TypeError(`${label}.text and ${label}.content disagree`);
  return text ?? content;
}

function normalizedNumber(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return Math.max(0, Math.min(1, value));
}

function declaredTokenCount(value: { readonly tokenCount?: number; readonly tokens?: number }, label: string): number | undefined {
  if (value.tokenCount !== undefined && value.tokens !== undefined && value.tokenCount !== value.tokens) {
    throw new TypeError(`${label}.tokenCount and ${label}.tokens disagree`);
  }
  const count = value.tokenCount ?? value.tokens;
  if (count === undefined) return undefined;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) throw new TypeError(`${label}.tokenCount must be a non-negative integer`);
  return count;
}

function tokenCount(text: string, estimator: TokenEstimator): number {
  if (text.length === 0) return 0;
  const value = estimator(text);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError("tokenEstimator must return a finite non-negative number");
  return Math.max(1, Math.ceil(value));
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
}

function validateNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer`);
}

function timeMillis(value: TimeValue | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const result = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError(`${label} must be a valid date or timestamp`);
  return result;
}

function normalizedDedupeKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function sourceScore(candidate: ContextCandidate): number {
  if (candidate.score !== undefined) return normalizedNumber(candidate.score, `${candidate.id}.score`, 0.5);
  const relevance = normalizedNumber(candidate.relevance, `${candidate.id}.relevance`, 0.5);
  const priority = normalizedNumber(candidate.priority, `${candidate.id}.priority`, 0.5);
  const recency = normalizedNumber(candidate.recency, `${candidate.id}.recency`, 0.5);
  return relevance * 0.6 + priority * 0.3 + recency * 0.1;
}

function rawSegment(value: string | ContextInputChunk, candidate: ContextCandidate, index: number): RawSegment {
  if (typeof value === "string") {
    return {
      requestedId: undefined,
      text: value,
      tokenCount: undefined,
      kind: undefined,
      parentId: undefined,
      dedupeKey: undefined
    };
  }
  if (!isRecord(value)) throw new TypeError(`${candidate.id}.chunks[${index}] must be a string or object`);
  const text = textFrom(value as ContextInputChunk, `${candidate.id}.chunks[${index}]`);
  if (text === undefined) throw new TypeError(`${candidate.id}.chunks[${index}] needs text or content`);
  const kind = value.kind === undefined ? undefined : normalizedKind(value.kind, `${candidate.id}.chunks[${index}].kind`);
  const parentId = value.parentId === undefined ? undefined : nonEmptyId(value.parentId, `${candidate.id}.chunks[${index}].parentId`);
  const dedupeKey = value.dedupeKey === undefined ? undefined : nonEmptyId(value.dedupeKey, `${candidate.id}.chunks[${index}].dedupeKey`);
  return {
    requestedId: value.id === undefined ? undefined : nonEmptyId(value.id, `${candidate.id}.chunks[${index}].id`),
    text,
    tokenCount: declaredTokenCount(value as ContextInputChunk, `${candidate.id}.chunks[${index}]`),
    kind,
    parentId,
    dedupeKey
  };
}

function sourceSegments(candidate: ContextCandidate): RawSegment[] {
  const hasChunks = candidate.chunks !== undefined;
  if (hasChunks && (candidate.text !== undefined || candidate.content !== undefined || candidate.summary !== undefined)) {
    throw new TypeError(`${candidate.id} cannot combine chunks with text, content, or summary`);
  }
  if (hasChunks) {
    if (!Array.isArray(candidate.chunks)) throw new TypeError(`${candidate.id}.chunks must be an array`);
    return candidate.chunks.map((chunk, index) => rawSegment(chunk, candidate, index));
  }
  const kind = normalizedKind(candidate.kind, `${candidate.id}.kind`);
  const text = textFrom(candidate, candidate.id);
  const summary = normalizedText(candidate.summary, `${candidate.id}.summary`);
  if (kind === "summary" && text === undefined && summary !== undefined) {
    return [{ requestedId: undefined, text: summary, tokenCount: declaredTokenCount(candidate, candidate.id), kind: "summary", parentId: undefined, dedupeKey: undefined }];
  }
  if (text === undefined) return [];
  return [{ requestedId: undefined, text, tokenCount: declaredTokenCount(candidate, candidate.id), kind: undefined, parentId: undefined, dedupeKey: undefined }];
}

function sourceFrom(candidate: ContextCandidate, sourceId: string, memoryId: string, kind: ContextKind, parentId: string | undefined, segments: readonly RawSegment[]): SourceDescriptor {
  const topic = candidate.topic ?? candidate.groupId ?? memoryId;
  const freshness = normalizedFreshness(candidate.freshness ?? candidate.status, `${candidate.id}.freshness`);
  const dedupeKey = candidate.dedupeKey === undefined ? undefined : nonEmptyId(candidate.dedupeKey, `${candidate.id}.dedupeKey`);
  return {
    sourceId,
    memoryId,
    kind,
    parentId,
    topic: nonEmptyId(topic, `${candidate.id}.topic`),
    score: sourceScore(candidate),
    freshness,
    observedAt: candidate.observedAt,
    expiresAt: candidate.expiresAt,
    dedupeKey,
    metadata: candidate.metadata,
    segments
  };
}

function expandCandidate(candidate: ContextCandidate): SourceDescriptor[] {
  const id = nonEmptyId(candidate.id, "candidate.id");
  const kind = normalizedKind(candidate.kind, `${id}.kind`);
  const parentId = candidate.parentId === undefined ? undefined : nonEmptyId(candidate.parentId, `${id}.parentId`);
  const segments = sourceSegments(candidate);
  const summary = normalizedText(candidate.summary, `${id}.summary`);
  if (candidate.chunks !== undefined || kind === "summary" || summary === undefined || summary.trim().length === 0) {
    const source = sourceFrom(candidate, id, id, kind, parentId, segments);
    return [source];
  }

  const summaryId = `${id}:summary`;
  const summarySource = sourceFrom(candidate, summaryId, id, "summary", parentId, [{
    requestedId: undefined,
    text: summary,
    tokenCount: undefined,
    kind: "summary",
    parentId,
    dedupeKey: undefined
  }]);
  const detailSource = sourceFrom(candidate, id, id, "detail", summaryId, segments);
  return [summarySource, detailSource];
}

function splitOversizedWord(word: string, maxTokens: number, estimator: TokenEstimator): string[] {
  const parts: string[] = [];
  let part = "";
  for (const character of Array.from(word)) {
    const next = `${part}${character}`;
    if (part.length > 0 && tokenCount(next, estimator) > maxTokens) {
      parts.push(part);
      part = character;
      if (tokenCount(part, estimator) > maxTokens) {
        parts.push(part);
        part = "";
      }
    } else {
      part = next;
      if (tokenCount(part, estimator) > maxTokens) {
        parts.push(part);
        part = "";
      }
    }
  }
  if (part.length > 0) parts.push(part);
  return parts;
}

export function chunkText(text: string, maxTokens: number, estimator: TokenEstimator = defaultTokenEstimator): readonly string[] {
  assertString(text, "text");
  validatePositiveInteger(maxTokens, "maxTokens");
  const value = text.trim();
  if (value.length === 0) return [];
  const words = value.split(/\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (tokenCount(candidate, estimator) <= maxTokens) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
    if (tokenCount(word, estimator) <= maxTokens) current = word;
    else chunks.push(...splitOversizedWord(word, maxTokens, estimator));
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function materializeUnits(source: SourceDescriptor, chunkSizeTokens: number, estimator: TokenEstimator, startOrdinal: number, usedIds: Set<string>): Unit[] {
  const units: Unit[] = [];
  let ordinal = startOrdinal;
  const segments = source.segments.length === 0
    ? [{ requestedId: undefined, text: "", tokenCount: 0, kind: undefined, parentId: undefined, dedupeKey: undefined }]
    : source.segments;
  for (const segment of segments) {
    const text = segment.text.trim();
    const declared = segment.tokenCount;
    if (text.length > 0 && declared === 0) throw new RangeError(`${source.sourceId}.tokenCount must be positive for non-empty text`);
    const estimated = tokenCount(text, estimator);
    const canUseDeclared = declared !== undefined && declared <= chunkSizeTokens;
    const pieces = text.length === 0
      ? []
      : estimated <= chunkSizeTokens && (declared === undefined || canUseDeclared)
        ? [text]
        : chunkText(text, chunkSizeTokens, estimator);
    const outputPieces = pieces.length === 0 ? [""] : pieces;
    for (let index = 0; index < outputPieces.length; index += 1) {
      const piece = outputPieces[index]!;
      const pieceTokens = piece.length === 0
        ? 0
        : outputPieces.length === 1 && canUseDeclared
          ? declared!
          : outputPieces.length === 1 && piece === text
            ? estimated
            : tokenCount(piece, estimator);
      const baseId = outputPieces.length === 1 && segment.requestedId === undefined
        ? source.sourceId
        : `${source.sourceId}#${segment.requestedId ?? index + 1}`;
      let id = baseId;
      let suffix = 1;
      while (usedIds.has(id)) {
        id = `${baseId}~${suffix}`;
        suffix += 1;
      }
      usedIds.add(id);
      const kind = segment.kind ?? source.kind;
      const parentId = segment.parentId ?? source.parentId;
      const dedupeKey = normalizedDedupeKey(segment.dedupeKey ?? source.dedupeKey ?? piece);
      units.push({
        id,
        sourceId: source.sourceId,
        memoryId: source.memoryId,
        text: piece,
        tokens: pieceTokens,
        kind,
        parentId,
        topic: source.topic,
        freshness: source.freshness,
        score: source.score,
        dedupeKey,
        metadata: source.metadata,
        ordinal,
        depth: 0,
        phase: 0,
        hierarchyIssue: undefined
      });
      ordinal += 1;
    }
  }
  return units;
}

function inspectSourceHierarchy(sourceId: string, sources: ReadonlyMap<string, SourceDescriptor>, memo: Map<string, HierarchyInfo>, states: Map<string, "visiting" | "done">): HierarchyInfo {
  const cached = memo.get(sourceId);
  if (cached !== undefined) return cached;
  const state = states.get(sourceId);
  if (state === "visiting") return { depth: 0, issue: "hierarchy-cycle" };
  const source = sources.get(sourceId);
  if (source === undefined) {
    const missing: HierarchyInfo = { depth: 0, issue: "parent-missing" };
    memo.set(sourceId, missing);
    return missing;
  }
  states.set(sourceId, "visiting");
  let info: HierarchyInfo;
  if (source.parentId === undefined) {
    info = { depth: 0, issue: undefined };
  } else if (!sources.has(source.parentId)) {
    info = { depth: 0, issue: "parent-missing" };
  } else {
    const parent = inspectSourceHierarchy(source.parentId, sources, memo, states);
    info = parent.issue === undefined ? { depth: parent.depth + 1, issue: undefined } : { depth: 0, issue: parent.issue };
  }
  states.set(sourceId, "done");
  memo.set(sourceId, info);
  return info;
}

function unitHierarchy(unit: Unit, sources: ReadonlyMap<string, SourceDescriptor>, memo: Map<string, HierarchyInfo>, states: Map<string, "visiting" | "done">): HierarchyInfo {
  if (unit.parentId === undefined) return inspectSourceHierarchy(unit.sourceId, sources, memo, states);
  if (unit.parentId === unit.sourceId) return { depth: 0, issue: "hierarchy-cycle" };
  const parent = inspectSourceHierarchy(unit.parentId, sources, memo, states);
  return parent.issue === undefined ? { depth: parent.depth + 1, issue: undefined } : { depth: 0, issue: parent.issue };
}

function compareUnits(left: Unit, right: Unit): number {
  if (left.kind !== right.kind) return left.kind === "summary" ? -1 : 1;
  if (left.score !== right.score) return right.score - left.score;
  if (left.tokens !== right.tokens) return left.tokens - right.tokens;
  return left.ordinal - right.ordinal;
}

function orderedUnits(units: readonly Unit[], diversityWeight: number): Unit[] {
  const stages = new Map<number, Unit[]>();
  for (const unit of units) {
    const stage = unit.phase;
    const stageUnits = stages.get(stage);
    if (stageUnits === undefined) stages.set(stage, [unit]);
    else stageUnits.push(unit);
  }
  const ordered: Unit[] = [];
  const stageKeys = [...stages.keys()].sort((left, right) => left - right);
  for (const stageKey of stageKeys) {
    const stageUnits = stages.get(stageKey)!;
    stageUnits.sort(compareUnits);
    if (diversityWeight <= 0) {
      ordered.push(...stageUnits);
      continue;
    }
    const groups = new Map<string, Unit[]>();
    for (const unit of stageUnits) {
      const group = groups.get(unit.topic);
      if (group === undefined) groups.set(unit.topic, [unit]);
      else group.push(unit);
    }
    const groupEntries = [...groups.entries()].map(([topic, group]) => ({ topic, group, index: 0 }));
    groupEntries.sort((left, right) => compareUnits(left.group[0]!, right.group[0]!));
    let remaining = stageUnits.length;
    while (remaining > 0) {
      for (const entry of groupEntries) {
        const unit = entry.group[entry.index];
        if (unit === undefined) continue;
        ordered.push(unit);
        entry.index += 1;
        remaining -= 1;
      }
    }
  }
  return ordered;
}

function mergeGate(base: FreshnessGate | undefined, override: FreshnessGate | undefined, now: TimeValue | undefined): FreshnessGate {
  const gate: FreshnessGate = { ...(base ?? {}), ...(override ?? {}) };
  if (now !== undefined) return { ...gate, now };
  return gate;
}

function gateUnit(unit: Unit, source: SourceDescriptor, gate: FreshnessGate): SelectionSkipReason | undefined {
  if (unit.text.length === 0) return "empty";
  if (unit.freshness === "INVALID") return "invalid-freshness";
  const now = timeMillis(gate.now, "freshnessGate.now") ?? Date.now();
  const expiresAt = timeMillis(source.expiresAt, `${source.sourceId}.expiresAt`);
  const observedAt = timeMillis(source.observedAt, `${source.sourceId}.observedAt`);
  const expired = expiresAt !== undefined && expiresAt <= now;
  const tooOld = gate.maxAgeMs !== undefined && observedAt !== undefined && now - observedAt >= gate.maxAgeMs;
  const freshness: FreshnessStatus = unit.freshness === "FRESH" && (expired || tooOld) ? "STALE" : unit.freshness;
  unit.freshness = freshness;
  if (freshness === "STALE" && !gate.allowStale && !(gate.allowStaleSummaries === true && unit.kind === "summary")) {
    return expired || tooOld ? "expired" : "stale";
  }
  if (freshness === "UNKNOWN" && gate.allowUnknown !== true) return "unknown-freshness";
  return undefined;
}

function betterDuplicate(left: Unit, right: Unit): boolean {
  if (left.score !== right.score) return left.score > right.score;
  if (left.depth !== right.depth) return left.depth < right.depth;
  if (left.kind !== right.kind) return left.kind === "summary";
  return left.ordinal < right.ordinal;
}

function internalTrace(unit: Unit): InternalTrace {
  return { unit, decision: "pending", reason: "pending", duplicateOf: undefined, order: undefined };
}

function publicTrace(record: InternalTrace): SelectionTraceEntry {
  const base = {
    id: record.unit.id,
    sourceId: record.unit.sourceId,
    memoryId: record.unit.memoryId,
    decision: (record.decision === "selected" ? "selected" : "skipped") as "selected" | "skipped",
    reason: record.reason === "pending" ? "budget" : record.reason,
    tokens: record.unit.tokens,
    kind: record.unit.kind,
    topic: record.unit.topic,
    freshness: record.unit.freshness,
    score: record.unit.score,
    phase: record.unit.phase
  };
  return {
    ...base,
    ...(record.unit.parentId === undefined ? {} : { parentId: record.unit.parentId }),
    ...(record.duplicateOf === undefined ? {} : { duplicateOf: record.duplicateOf }),
    ...(record.order === undefined ? {} : { order: record.order })
  };
}

function publicSelected(unit: Unit, order: number): SelectedContextChunk {
  const base = {
    id: unit.id,
    sourceId: unit.sourceId,
    memoryId: unit.memoryId,
    text: unit.text,
    content: unit.text,
    tokens: unit.tokens,
    kind: unit.kind,
    topic: unit.topic,
    freshness: unit.freshness,
    score: unit.score,
    order
  };
  return {
    ...base,
    ...(unit.parentId === undefined ? {} : { parentId: unit.parentId }),
    ...(unit.metadata === undefined ? {} : { metadata: unit.metadata })
  };
}

function degradationReason(reason: SelectionReason): DegradationReason | undefined {
  if (reason === "budget") return "token-budget";
  if (reason === "stale" || reason === "expired" || reason === "unknown-freshness" || reason === "invalid-freshness") return "freshness-gate";
  if (reason === "duplicate") return "deduplication";
  if (reason === "parent-not-selected" || reason === "parent-missing" || reason === "hierarchy-cycle") return "hierarchy";
  if (reason === "max-chunks" || reason === "max-sources") return "limits";
  return undefined;
}

function requestCandidates(request: ContextSelectionRequest): readonly ContextCandidate[] {
  return request.candidates ?? request.items ?? request.memories ?? [];
}

function requestBudget(request: ContextSelectionRequest): number {
  if (request.tokenBudget !== undefined && request.budget !== undefined && request.tokenBudget !== request.budget) {
    throw new RangeError("tokenBudget and budget disagree");
  }
  const budget = request.tokenBudget ?? request.budget;
  if (budget === undefined) throw new RangeError("tokenBudget is required");
  validatePositiveInteger(budget, "tokenBudget");
  return budget;
}

function requestLimits(
  chunkSize: number | undefined,
  maxChunks: number | undefined,
  maxSources: number | undefined,
  diversityWeight: number | undefined,
  effectiveBudget: number
): { readonly chunkSizeTokens: number; readonly maxChunks: number; readonly maxSources: number; readonly diversityWeight: number } {
  const configuredChunkSize = chunkSize ?? Math.min(512, Math.max(1, effectiveBudget));
  validatePositiveInteger(configuredChunkSize, "chunkSizeTokens");
  const configuredMaxChunks = maxChunks ?? Number.POSITIVE_INFINITY;
  const configuredMaxSources = maxSources ?? Number.POSITIVE_INFINITY;
  if (maxChunks !== undefined) validateNonNegativeInteger(maxChunks, "maxChunks");
  if (maxSources !== undefined) validateNonNegativeInteger(maxSources, "maxSources");
  const configuredDiversityWeight = diversityWeight ?? 0.35;
  if (typeof configuredDiversityWeight !== "number" || !Number.isFinite(configuredDiversityWeight) || configuredDiversityWeight < 0 || configuredDiversityWeight > 1) {
    throw new RangeError("diversityWeight must be between 0 and 1");
  }
  return {
    chunkSizeTokens: Math.min(configuredChunkSize, Math.max(1, effectiveBudget)),
    maxChunks: configuredMaxChunks,
    maxSources: configuredMaxSources,
    diversityWeight: configuredDiversityWeight
  };
}

export class ContextEngine {
  private readonly options: ContextEngineOptions;

  constructor(options: ContextEngineOptions = {}) {
    this.options = options;
  }

  select(request: ContextSelectionRequest): ContextSelectionResult {
    const tokenBudget = requestBudget(request);
    const reservedTokens = request.reservedTokens ?? 0;
    validateNonNegativeInteger(reservedTokens, "reservedTokens");
    if (reservedTokens > tokenBudget) throw new RangeError("reservedTokens cannot exceed tokenBudget");
    const usableTokenBudget = tokenBudget - reservedTokens;
    const limits = requestLimits(
      request.chunkSizeTokens ?? this.options.chunkSizeTokens,
      request.maxChunks,
      request.maxSources,
      request.diversityWeight ?? this.options.diversityWeight,
      usableTokenBudget
    );
    const estimator = request.tokenEstimator ?? this.options.tokenEstimator ?? defaultTokenEstimator;
    const tokenCache = new Map<string, number>();
    const cachedEstimator: TokenEstimator = (text) => {
      const cached = tokenCache.get(text);
      if (cached !== undefined) return cached;
      const estimated = estimator(text);
      tokenCache.set(text, estimated);
      return estimated;
    };
    const gate = mergeGate(this.options.freshnessGate, request.freshnessGate, request.now);
    if (gate.maxAgeMs !== undefined && (typeof gate.maxAgeMs !== "number" || !Number.isFinite(gate.maxAgeMs) || gate.maxAgeMs < 0)) {
      throw new RangeError("freshnessGate.maxAgeMs must be a non-negative finite number");
    }

    const candidates = requestCandidates(request);
    const sources: SourceDescriptor[] = [];
    const sourceIds = new Set<string>();
    for (const candidate of candidates) {
      if (!isRecord(candidate)) throw new TypeError("each context candidate must be an object");
      const expanded = expandCandidate(candidate);
      for (const source of expanded) {
        if (sourceIds.has(source.sourceId)) throw new RangeError(`duplicate context source id: ${source.sourceId}`);
        sourceIds.add(source.sourceId);
        sources.push(source);
      }
    }
    const sourceMap = new Map<string, SourceDescriptor>();
    for (const source of sources) sourceMap.set(source.sourceId, source);
    const units: Unit[] = [];
    const unitIds = new Set<string>();
    for (const source of sources) units.push(...materializeUnits(source, limits.chunkSizeTokens, cachedEstimator, units.length, unitIds));
    const traceRecords = units.map(internalTrace);
    const recordsById = new Map<string, InternalTrace>();
    for (const record of traceRecords) recordsById.set(record.unit.id, record);
    const hierarchyMemo = new Map<string, HierarchyInfo>();
    const hierarchyStates = new Map<string, "visiting" | "done">();
    for (const unit of units) {
      const hierarchy = unitHierarchy(unit, sourceMap, hierarchyMemo, hierarchyStates);
      unit.depth = hierarchy.depth;
      unit.phase = hierarchy.depth * 2 + (unit.kind === "summary" ? 0 : 1);
      unit.hierarchyIssue = hierarchy.issue;
    }

    const deduplicated = new Map<string, Unit>();
    for (const unit of units) {
      const record = recordsById.get(unit.id)!;
      const source = sourceMap.get(unit.sourceId)!;
      const freshnessReason = gateUnit(unit, source, gate);
      if (freshnessReason !== undefined) {
        record.decision = "skipped";
        record.reason = freshnessReason;
        continue;
      }
      if (unit.hierarchyIssue !== undefined) {
        record.decision = "skipped";
        record.reason = unit.hierarchyIssue;
        continue;
      }
      const previous = deduplicated.get(unit.dedupeKey);
      if (previous === undefined) {
        deduplicated.set(unit.dedupeKey, unit);
      } else if (betterDuplicate(unit, previous)) {
        const previousRecord = recordsById.get(previous.id)!;
        previousRecord.decision = "skipped";
        previousRecord.reason = "duplicate";
        previousRecord.duplicateOf = unit.id;
        deduplicated.set(unit.dedupeKey, unit);
      } else {
        record.decision = "skipped";
        record.reason = "duplicate";
        record.duplicateOf = previous.id;
      }
    }

    const pendingUnits = [...deduplicated.values()];
    const ordered = orderedUnits(pendingUnits, limits.diversityWeight);
    const selectedUnits: Unit[] = [];
    const selectedSources = new Set<string>();
    const selectedTopics = new Set<string>();
    let tokensUsed = 0;
    let limitReached = false;
    for (const unit of ordered) {
      const record = recordsById.get(unit.id)!;
      if (record.decision !== "pending") continue;
      if (selectedUnits.length >= limits.maxChunks) {
        limitReached = true;
        break;
      }
      if (unit.parentId !== undefined && !selectedSources.has(unit.parentId)) {
        record.decision = "skipped";
        record.reason = "parent-not-selected";
        continue;
      }
      if (!selectedSources.has(unit.sourceId) && selectedSources.size >= limits.maxSources) {
        record.decision = "skipped";
        record.reason = "max-sources";
        continue;
      }
      if (unit.tokens > usableTokenBudget - tokensUsed) {
        record.decision = "skipped";
        record.reason = "budget";
        continue;
      }
      record.decision = "selected";
      record.reason = "selected";
      record.order = selectedUnits.length;
      selectedUnits.push(unit);
      selectedSources.add(unit.sourceId);
      selectedTopics.add(unit.topic);
      tokensUsed += unit.tokens;
    }
    if (limitReached) {
      for (const unit of ordered) {
        const record = recordsById.get(unit.id)!;
        if (record.decision === "pending") {
          record.decision = "skipped";
          record.reason = "max-chunks";
        }
      }
    }
    for (const record of traceRecords) {
      if (record.decision === "pending") {
        record.decision = "skipped";
        record.reason = "budget";
      }
    }
    if (tokensUsed > usableTokenBudget) throw new Error("context selection exceeded its token budget");

    const trace = traceRecords.map(publicTrace);
    const omitted = trace.filter((entry) => entry.decision === "skipped");
    const reasons = new Set<DegradationReason>();
    for (const entry of omitted) {
      const reason = degradationReason(entry.reason);
      if (reason !== undefined) reasons.add(reason);
    }
    const selected = selectedUnits.map(publicSelected);
    return {
      selected,
      trace,
      omitted,
      tokenBudget,
      usableTokenBudget,
      reservedTokens,
      tokensUsed,
      remainingTokens: usableTokenBudget - tokensUsed,
      degraded: reasons.size > 0,
      degradationReasons: [...reasons],
      stats: {
        candidateCount: candidates.length,
        sourceCount: sources.length,
        chunkCount: units.length,
        selectedChunkCount: selected.length,
        selectedSourceCount: selectedSources.size,
        selectedTopicCount: selectedTopics.size
      }
    };
  }
}

export function selectContext(request: ContextSelectionRequest): ContextSelectionResult {
  return new ContextEngine().select(request);
}
