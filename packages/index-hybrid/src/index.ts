export type MetadataScalar = string | number | boolean | null;
export type MetadataValue = MetadataScalar | readonly MetadataScalar[];
export type Metadata = Readonly<Record<string, MetadataValue>>;

export interface HybridDocument<T = unknown> {
  readonly id: string;
  readonly text: string;
  readonly metadata?: Metadata;
  readonly content?: T;
}

export type IndexDocument<T = unknown> = HybridDocument<T>;

export type EmbeddingVector = ArrayLike<number>;
export type VectorProviderMode = "external" | "local-token-fallback";

export interface VectorProvider {
  readonly name?: string;
  readonly mode?: VectorProviderMode;
  embed(text: string): EmbeddingVector | Promise<EmbeddingVector>;
}

export type EmbeddingProvider = VectorProvider;

export type Tokenizer = (text: string) => readonly string[];

export function defaultTokenizer(text: string): readonly string[] {
  const normalized = text.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "");
  return normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * A deterministic token-hash vector for local operation. It is a lexical
 * fallback, not a semantic embedding and must not be described as one.
 */
export class LocalFallbackVectorProvider implements VectorProvider {
  readonly name = "local-token-fallback";
  readonly mode = "local-token-fallback" as const;

  constructor(
    readonly dimensions = 128,
    private readonly tokenizer: Tokenizer = defaultTokenizer
  ) {
    if (!Number.isInteger(dimensions) || dimensions < 1) throw new RangeError("Fallback vector dimensions must be a positive integer");
  }

  embed(text: string): readonly number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const token of this.tokenizer(text)) {
      let hash = 2166136261;
      for (const character of token) {
        hash ^= character.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      const bucket = hash % this.dimensions;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
    }
    return vector;
  }
}

export { LocalFallbackVectorProvider as LocalTokenVectorProvider };

export interface MetadataOperators {
  readonly $eq?: MetadataValue;
  readonly $ne?: MetadataValue;
  readonly $in?: readonly MetadataScalar[];
  readonly $nin?: readonly MetadataScalar[];
  readonly $exists?: boolean;
  readonly $gt?: number;
  readonly $gte?: number;
  readonly $lt?: number;
  readonly $lte?: number;
  readonly $contains?: MetadataScalar;
  readonly $prefix?: string;
}

export type MetadataCondition = MetadataValue | MetadataOperators;
export type MetadataFilter = Readonly<Record<string, MetadataCondition>>;
export type MetadataPredicate<T = unknown> = (metadata: Metadata | undefined, document: HybridDocument<T>) => boolean;

export interface HybridIndexOptions {
  readonly vectorProvider?: VectorProvider;
  readonly tokenizer?: Tokenizer;
  readonly lexicalWeight?: number;
  readonly vectorWeight?: number;
}

export interface SearchOptions<T = unknown> {
  readonly limit?: number;
  readonly filter?: MetadataFilter | MetadataPredicate<T>;
  readonly filters?: MetadataFilter | MetadataPredicate<T>;
  readonly lexicalWeight?: number;
  readonly vectorWeight?: number;
  readonly minScore?: number;
}

export interface LexicalExplanation {
  readonly queryTokens: readonly string[];
  readonly matchedTokens: readonly string[];
  readonly bm25: number;
  readonly normalizedScore: number;
  readonly tokenCoverage: number;
}

export interface VectorExplanation {
  readonly provider: string;
  readonly mode: VectorProviderMode;
  readonly used: boolean;
  readonly cosineSimilarity: number;
  readonly normalizedScore: number;
}

export interface FusionExplanation {
  readonly lexicalWeight: number;
  readonly vectorWeight: number;
  readonly finalScore: number;
  readonly rank: number;
  readonly tieBreak: "score desc, lexical desc, vector desc, id asc";
}

export interface RetrievalExplanation {
  readonly reasons: readonly string[];
  readonly metadata: {
    readonly filterApplied: boolean;
    readonly matched: true;
  };
  readonly lexical: LexicalExplanation;
  readonly vector: VectorExplanation;
  readonly fusion: FusionExplanation;
}

export interface HybridSearchResult<T = unknown> extends HybridDocument<T> {
  readonly document: HybridDocument<T>;
  readonly score: number;
  readonly lexicalScore: number;
  readonly vectorScore: number;
  readonly explanation: RetrievalExplanation;
}

interface StoredDocument<T> {
  readonly document: HybridDocument<T>;
  readonly tokens: readonly string[];
  readonly termFrequency: ReadonlyMap<string, number>;
  readonly vector: readonly number[];
}

interface ScoreParts {
  readonly queryTokens: readonly string[];
  readonly bm25: number;
  readonly lexicalScore: number;
  readonly matchedTokens: readonly string[];
  readonly tokenCoverage: number;
  readonly cosineSimilarity: number;
  readonly vectorScore: number;
  readonly score: number;
}

interface ScoredDocument<T> {
  readonly stored: StoredDocument<T>;
  readonly parts: ScoreParts;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_LEXICAL_WEIGHT = 0.5;
const DEFAULT_VECTOR_WEIGHT = 0.5;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const FILTER_OPERATORS = new Set([
  "$eq", "$ne", "$in", "$nin", "$exists", "$gt", "$gte", "$lt", "$lte", "$contains", "$prefix"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isMetadataScalar(value: unknown): value is MetadataScalar {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function isMetadataValue(value: unknown): value is MetadataValue {
  return isMetadataScalar(value) || (Array.isArray(value) && value.every(isMetadataScalar));
}

function cloneMetadata(metadata: Metadata): Metadata {
  const clone: Record<string, MetadataValue> = {};
  for (const key of Object.keys(metadata)) {
    const value = metadata[key];
    if (value === undefined) throw new TypeError(`Metadata field is undefined: ${key}`);
    clone[key] = Array.isArray(value) ? [...value] : value;
  }
  return clone;
}

function cloneDocument<T>(document: HybridDocument<T>): HybridDocument<T> {
  return document.metadata === undefined
    ? { ...document }
    : { ...document, metadata: cloneMetadata(document.metadata) };
}

function snapshotDocument<T>(input: HybridDocument<T>): HybridDocument<T> {
  if (!isRecord(input)) throw new TypeError("Hybrid document must be an object");
  if (typeof input.id !== "string" || input.id.trim().length === 0) throw new TypeError("Hybrid document id must be a non-empty string");
  if (typeof input.text !== "string") throw new TypeError("Hybrid document text must be a string");
  if (input.metadata !== undefined) {
    if (!isRecord(input.metadata)) throw new TypeError("Hybrid document metadata must be an object");
    for (const [key, value] of Object.entries(input.metadata)) {
      if (key.length === 0 || !isMetadataValue(value)) throw new TypeError(`Invalid metadata value: ${key}`);
    }
  }
  return cloneDocument(input as HybridDocument<T>);
}

function tokenize(tokenizer: Tokenizer, text: string): readonly string[] {
  const raw = tokenizer(text);
  if (!Array.isArray(raw) || raw.some((token) => typeof token !== "string" || token.length === 0)) {
    throw new TypeError("Tokenizer must return non-empty strings");
  }
  return Object.freeze([...raw]);
}

function termFrequency(tokens: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function unique(tokens: readonly string[]): readonly string[] {
  return [...new Set(tokens)];
}

function validateWeight(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite non-negative number`);
  return value;
}

function resolveWeights(
  lexicalWeight: number | undefined,
  vectorWeight: number | undefined,
  defaultLexicalWeight: number,
  defaultVectorWeight: number
): { readonly lexicalWeight: number; readonly vectorWeight: number } {
  const lexical = validateWeight(lexicalWeight ?? defaultLexicalWeight, "lexicalWeight");
  const vector = validateWeight(vectorWeight ?? defaultVectorWeight, "vectorWeight");
  if (lexical + vector === 0) throw new RangeError("At least one fusion weight must be greater than zero");
  return { lexicalWeight: lexical, vectorWeight: vector };
}

function validateLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError("limit must be a non-negative integer");
  return limit;
}

function providerName(provider: VectorProvider): string {
  return provider.name?.trim() || "anonymous-vector-provider";
}

function providerMode(provider: VectorProvider): VectorProviderMode {
  return provider.mode ?? "external";
}

async function embed(provider: VectorProvider, text: string): Promise<readonly number[]> {
  const result = await provider.embed(text);
  if (result === null || typeof result !== "object" || !Number.isInteger(result.length) || result.length < 1) {
    throw new TypeError("Vector provider must return a non-empty vector");
  }
  const vector = Array.from(result);
  if (vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new TypeError("Vector provider returned a non-finite component");
  }
  return Object.freeze(vector);
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) throw new Error("Vector dimensions do not match");
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(leftMagnitude * rightMagnitude)));
}

function normalizedBm25(value: number): number {
  return value <= 0 ? 0 : value / (value + 1);
}

function bm25(
  queryTokens: readonly string[],
  document: StoredDocument<unknown>,
  documentCount: number,
  documentFrequency: ReadonlyMap<string, number>,
  averageDocumentLength: number
): { readonly score: number; readonly matchedTokens: readonly string[] } {
  const matchedTokens: string[] = [];
  let score = 0;
  const denominatorLength = BM25_K1 * (1 - BM25_B + BM25_B * document.tokens.length / averageDocumentLength);
  for (const token of unique(queryTokens)) {
    const frequency = document.termFrequency.get(token) ?? 0;
    if (frequency === 0) continue;
    matchedTokens.push(token);
    const documentFrequencyValue = documentFrequency.get(token) ?? 0;
    const inverseDocumentFrequency = Math.log(1 + (documentCount - documentFrequencyValue + 0.5) / (documentFrequencyValue + 0.5));
    score += inverseDocumentFrequency * (frequency * (BM25_K1 + 1)) / (frequency + denominatorLength);
  }
  return { score, matchedTokens };
}

function equalScalar(left: MetadataScalar, right: MetadataScalar): boolean {
  return left === right;
}

function equalValue(left: MetadataValue, right: MetadataValue): boolean {
  if (!Array.isArray(left) && !Array.isArray(right)) return equalScalar(left as MetadataScalar, right as MetadataScalar);
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function valueContains(value: MetadataValue, expected: MetadataScalar): boolean {
  return Array.isArray(value) ? value.some((entry) => equalScalar(entry, expected)) : typeof value === "string" && typeof expected === "string" && value.includes(expected);
}

function valueIn(value: MetadataValue, expected: readonly MetadataScalar[]): boolean {
  return Array.isArray(value)
    ? value.some((entry) => expected.some((candidate) => equalScalar(entry, candidate)))
    : expected.some((candidate) => equalScalar(value as MetadataScalar, candidate));
}

function isOperatorObject(value: unknown): value is MetadataOperators {
  return isRecord(value) && Object.keys(value).every((key) => FILTER_OPERATORS.has(key));
}

function validOperatorObject(value: unknown): value is MetadataOperators {
  if (!isRecord(value) || !isOperatorObject(value) || Object.keys(value).length === 0) return false;
  if (hasOwn(value, "$eq") && !isMetadataValue(value.$eq)) return false;
  if (hasOwn(value, "$ne") && !isMetadataValue(value.$ne)) return false;
  if (hasOwn(value, "$in") && (!Array.isArray(value.$in) || !value.$in.every(isMetadataScalar))) return false;
  if (hasOwn(value, "$nin") && (!Array.isArray(value.$nin) || !value.$nin.every(isMetadataScalar))) return false;
  if (hasOwn(value, "$exists") && typeof value.$exists !== "boolean") return false;
  for (const key of ["$gt", "$gte", "$lt", "$lte"]) {
    if (hasOwn(value, key) && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) return false;
  }
  if (hasOwn(value, "$contains") && !isMetadataScalar(value.$contains)) return false;
  if (hasOwn(value, "$prefix") && typeof value.$prefix !== "string") return false;
  return true;
}

function matchesCondition(value: MetadataValue | undefined, present: boolean, condition: MetadataCondition): boolean {
  if (isMetadataValue(condition)) return present && value !== undefined && equalValue(value, condition);
  if (!validOperatorObject(condition)) throw new TypeError("Invalid metadata filter operator");

  if (hasOwn(condition, "$exists") && condition.$exists !== present) return false;
  if (!present) {
    return hasOwn(condition, "$exists") && condition.$exists === false
      && !hasOwn(condition, "$eq")
      && !hasOwn(condition, "$in")
      && !hasOwn(condition, "$gt")
      && !hasOwn(condition, "$gte")
      && !hasOwn(condition, "$lt")
      && !hasOwn(condition, "$lte")
      && !hasOwn(condition, "$contains")
      && !hasOwn(condition, "$prefix");
  }
  if (value === undefined) return false;
  if (hasOwn(condition, "$eq") && !equalValue(value, condition.$eq as MetadataValue)) return false;
  if (hasOwn(condition, "$ne") && equalValue(value, condition.$ne as MetadataValue)) return false;
  if (hasOwn(condition, "$in") && !valueIn(value, condition.$in as readonly MetadataScalar[])) return false;
  if (hasOwn(condition, "$nin") && valueIn(value, condition.$nin as readonly MetadataScalar[])) return false;
  for (const [operator, test] of [["$gt", (entry: number, target: number) => entry > target], ["$gte", (entry: number, target: number) => entry >= target], ["$lt", (entry: number, target: number) => entry < target], ["$lte", (entry: number, target: number) => entry <= target]] as const) {
    if (hasOwn(condition, operator) && (typeof value !== "number" || !test(value, condition[operator] as number))) return false;
  }
  if (hasOwn(condition, "$contains") && !valueContains(value, condition.$contains as MetadataScalar)) return false;
  if (hasOwn(condition, "$prefix") && (typeof value !== "string" || !value.startsWith(condition.$prefix as string))) return false;
  return true;
}

function matchesFilter<T>(filter: MetadataFilter | MetadataPredicate<T>, document: HybridDocument<T>): boolean {
  if (typeof filter === "function") return filter(document.metadata, document);
  if (!isRecord(filter)) throw new TypeError("Metadata filter must be an object or predicate");
  const metadata = document.metadata;
  for (const [key, condition] of Object.entries(filter)) {
    const present = metadata !== undefined && hasOwn(metadata, key);
    if (!matchesCondition(present ? metadata?.[key] : undefined, present, condition)) return false;
  }
  return true;
}

function compareDescending(left: number, right: number): number {
  return left === right ? 0 : left > right ? -1 : 1;
}

function compareIds(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareScoredDocuments<T>(left: ScoredDocument<T>, right: ScoredDocument<T>): number {
  return compareDescending(left.parts.score, right.parts.score)
    || compareDescending(left.parts.lexicalScore, right.parts.lexicalScore)
    || compareDescending(left.parts.vectorScore, right.parts.vectorScore)
    || compareIds(left.stored.document.id, right.stored.document.id);
}

function insertTopK<T>(heap: Array<ScoredDocument<T>>, candidate: ScoredDocument<T>, limit: number): void {
  if (heap.length < limit) {
    heap.push(candidate);
    siftWorstUp(heap, heap.length - 1);
    return;
  }

  // The root is the worst retained result. A candidate that is not strictly
  // better cannot change the exact total ordering, so it is discarded.
  if (compareScoredDocuments(candidate, heap[0] as ScoredDocument<T>) >= 0) return;
  heap[0] = candidate;
  siftWorstDown(heap, 0);
}

function siftWorstUp<T>(heap: Array<ScoredDocument<T>>, start: number): void {
  let index = start;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareScoredDocuments(heap[index] as ScoredDocument<T>, heap[parent] as ScoredDocument<T>) <= 0) return;
    [heap[index], heap[parent]] = [heap[parent] as ScoredDocument<T>, heap[index] as ScoredDocument<T>];
    index = parent;
  }
}

function siftWorstDown<T>(heap: Array<ScoredDocument<T>>, start: number): void {
  let index = start;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (left < heap.length && compareScoredDocuments(heap[left] as ScoredDocument<T>, heap[worst] as ScoredDocument<T>) > 0) worst = left;
    if (right < heap.length && compareScoredDocuments(heap[right] as ScoredDocument<T>, heap[worst] as ScoredDocument<T>) > 0) worst = right;
    if (worst === index) return;
    [heap[index], heap[worst]] = [heap[worst] as ScoredDocument<T>, heap[index] as ScoredDocument<T>];
    index = worst;
  }
}

function formatScore(value: number): string {
  return value.toFixed(4);
}

export class HybridIndex<T = unknown> {
  readonly vectorProvider: VectorProvider;
  readonly tokenizer: Tokenizer;
  private readonly defaultLexicalWeight: number;
  private readonly defaultVectorWeight: number;
  private readonly documents = new Map<string, StoredDocument<T>>();
  private readonly documentFrequency = new Map<string, number>();
  private readonly invertedIndex = new Map<string, Set<string>>();
  private totalDocumentLength = 0;
  private vectorDimensions: number | undefined;

  constructor(options: HybridIndexOptions = {}) {
    this.tokenizer = options.tokenizer ?? defaultTokenizer;
    if (typeof this.tokenizer !== "function") throw new TypeError("tokenizer must be a function");
    this.defaultLexicalWeight = validateWeight(options.lexicalWeight ?? DEFAULT_LEXICAL_WEIGHT, "lexicalWeight");
    this.defaultVectorWeight = validateWeight(options.vectorWeight ?? DEFAULT_VECTOR_WEIGHT, "vectorWeight");
    if (this.defaultLexicalWeight + this.defaultVectorWeight === 0) throw new RangeError("At least one fusion weight must be greater than zero");
    this.vectorProvider = options.vectorProvider ?? new LocalFallbackVectorProvider(128, this.tokenizer);
    if (this.vectorProvider.mode !== undefined && !["external", "local-token-fallback"].includes(this.vectorProvider.mode)) {
      throw new TypeError("Unknown vector provider mode");
    }
  }

  get size(): number {
    return this.documents.size;
  }

  get vectorProviderMode(): VectorProviderMode {
    return providerMode(this.vectorProvider);
  }

  async add(document: HybridDocument<T>): Promise<void> {
    return this.upsert(document);
  }

  async upsert(document: HybridDocument<T>): Promise<void> {
    const snapshot = snapshotDocument(document);
    const tokens = tokenize(this.tokenizer, snapshot.text);
    const vector = await embed(this.vectorProvider, snapshot.text);
    if (this.vectorDimensions !== undefined && vector.length !== this.vectorDimensions) {
      throw new RangeError(`Vector dimension changed from ${this.vectorDimensions} to ${vector.length}`);
    }

    const previous = this.documents.get(snapshot.id);
    if (previous !== undefined) this.removeStatistics(previous);
    this.documents.set(snapshot.id, { document: snapshot, tokens, termFrequency: termFrequency(tokens), vector });
    this.addStatistics(this.documents.get(snapshot.id) as StoredDocument<T>);
    this.vectorDimensions = vector.length;
  }

  async update(document: HybridDocument<T>): Promise<void> {
    if (!isRecord(document) || typeof document.id !== "string" || !this.documents.has(document.id)) {
      throw new Error(`Cannot update missing document: ${isRecord(document) ? String(document.id) : "unknown"}`);
    }
    return this.upsert(document);
  }

  delete(id: string): boolean {
    const document = this.documents.get(id);
    if (document === undefined) return false;
    this.removeStatistics(document);
    this.documents.delete(id);
    if (this.documents.size === 0) this.vectorDimensions = undefined;
    return true;
  }

  remove(id: string): boolean {
    return this.delete(id);
  }

  has(id: string): boolean {
    return this.documents.has(id);
  }

  get(id: string): HybridDocument<T> | undefined {
    const stored = this.documents.get(id);
    return stored === undefined ? undefined : cloneDocument(stored.document);
  }

  clear(): void {
    this.documents.clear();
    this.documentFrequency.clear();
    this.invertedIndex.clear();
    this.totalDocumentLength = 0;
    this.vectorDimensions = undefined;
  }

  async search(query: string, options: SearchOptions<T> = {}): Promise<readonly HybridSearchResult<T>[]> {
    if (typeof query !== "string") throw new TypeError("Search query must be a string");
    const limit = validateLimit(options.limit);
    if (limit === 0 || query.trim().length === 0 || this.documents.size === 0) return [];
    const weights = resolveWeights(options.lexicalWeight, options.vectorWeight, this.defaultLexicalWeight, this.defaultVectorWeight);
    const minimumScore = options.minScore ?? 0;
    if (!Number.isFinite(minimumScore) || minimumScore < 0) throw new RangeError("minScore must be a finite non-negative number");
    if (options.filter !== undefined && options.filters !== undefined) throw new TypeError("Use either filter or filters, not both");
    const queryTokens = tokenize(this.tokenizer, query);
    const distinctQueryTokens = unique(queryTokens);
    const filter = options.filter ?? options.filters;
    const candidateDocuments = weights.vectorWeight === 0
      ? [...new Set(distinctQueryTokens.flatMap((token) => [...(this.invertedIndex.get(token) ?? [])]))]
        .map((id) => this.documents.get(id))
        .filter((stored): stored is StoredDocument<T> => stored !== undefined)
      : [...this.documents.values()];
    const candidates = candidateDocuments.filter((stored) => filter === undefined || matchesFilter(filter, stored.document));
    if (candidates.length === 0) return [];

    const queryVector = weights.vectorWeight > 0 ? await embed(this.vectorProvider, query) : undefined;
    if (queryVector !== undefined && this.vectorDimensions !== undefined && queryVector.length !== this.vectorDimensions) {
      throw new RangeError(`Query vector dimension ${queryVector.length} does not match indexed dimension ${this.vectorDimensions}`);
    }
    const averageDocumentLength = Math.max(1, this.totalDocumentLength / this.documents.size);
    // Keep only the exact top-k set while scanning. The heap root is the
    // worst retained result under the public tie-break, so this cannot remove
    // a result that belongs in the final sorted prefix.
    const scored: Array<ScoredDocument<T>> = [];
    for (const stored of candidates) {
      const lexical = bm25(queryTokens, stored as StoredDocument<unknown>, this.documents.size, this.documentFrequency, averageDocumentLength);
      const cosine = queryVector === undefined ? 0 : cosineSimilarity(queryVector, stored.vector);
      const vectorScore = Math.max(0, cosine);
      const lexicalScore = normalizedBm25(lexical.score);
      const score = (weights.lexicalWeight * lexicalScore + weights.vectorWeight * vectorScore) / (weights.lexicalWeight + weights.vectorWeight);
      if (score < minimumScore || score <= 0) continue;
      insertTopK(scored, { stored, parts: { queryTokens: distinctQueryTokens, bm25: lexical.score, lexicalScore, matchedTokens: lexical.matchedTokens, tokenCoverage: distinctQueryTokens.length === 0 ? 0 : lexical.matchedTokens.length / distinctQueryTokens.length, cosineSimilarity: cosine, vectorScore, score } }, limit);
    }

    scored.sort(compareScoredDocuments);

    return scored.slice(0, limit).map(({ stored, parts }, index) => this.result(stored, parts, weights, filter !== undefined, index + 1));
  }

  async query(query: string, options: SearchOptions<T> = {}): Promise<readonly HybridSearchResult<T>[]> {
    return this.search(query, options);
  }

  private result(
    stored: StoredDocument<T>,
    parts: ScoreParts,
    weights: { readonly lexicalWeight: number; readonly vectorWeight: number },
    filterApplied: boolean,
    rank: number
  ): HybridSearchResult<T> {
    const document = cloneDocument(stored.document);
    const provider = providerName(this.vectorProvider);
    const mode = providerMode(this.vectorProvider);
    const vectorUsed = weights.vectorWeight > 0;
    const reasons: string[] = [];
    if (parts.matchedTokens.length > 0) reasons.push(`BM25 matched tokens: ${parts.matchedTokens.join(", ")}.`);
    else reasons.push("No BM25 token match; the vector component supplied the retrieval signal.");
    if (vectorUsed) {
      reasons.push(mode === "local-token-fallback"
        ? `Vector similarity came from ${provider}, a deterministic lexical token-hash fallback; it is not a semantic embedding.`
        : `Vector similarity came from the injected provider ${provider}.`);
    } else {
      reasons.push("Vector component disabled by a zero vector weight.");
    }
    if (filterApplied) reasons.push("Document passed the requested metadata filter.");
    reasons.push(`Final score is deterministic weighted fusion (${formatScore(weights.lexicalWeight)} BM25 + ${formatScore(weights.vectorWeight)} vector).`);
    const explanation: RetrievalExplanation = {
      reasons,
      metadata: { filterApplied, matched: true },
      lexical: {
        queryTokens: parts.queryTokens,
        matchedTokens: parts.matchedTokens,
        bm25: parts.bm25,
        normalizedScore: parts.lexicalScore,
        tokenCoverage: parts.tokenCoverage
      },
      vector: {
        provider,
        mode,
        used: vectorUsed,
        cosineSimilarity: parts.cosineSimilarity,
        normalizedScore: parts.vectorScore
      },
      fusion: {
        lexicalWeight: weights.lexicalWeight,
        vectorWeight: weights.vectorWeight,
        finalScore: parts.score,
        rank,
        tieBreak: "score desc, lexical desc, vector desc, id asc"
      }
    };
    return { ...document, document, score: parts.score, lexicalScore: parts.lexicalScore, vectorScore: parts.vectorScore, explanation };
  }

  private addStatistics(document: StoredDocument<T>): void {
    this.totalDocumentLength += document.tokens.length;
    for (const token of new Set(document.tokens)) {
      this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
      const postings = this.invertedIndex.get(token) ?? new Set<string>();
      postings.add(document.document.id);
      this.invertedIndex.set(token, postings);
    }
  }

  private removeStatistics(document: StoredDocument<T>): void {
    this.totalDocumentLength -= document.tokens.length;
    for (const token of new Set(document.tokens)) {
      const next = (this.documentFrequency.get(token) ?? 0) - 1;
      if (next <= 0) this.documentFrequency.delete(token); else this.documentFrequency.set(token, next);
      const postings = this.invertedIndex.get(token);
      if (postings !== undefined) {
        postings.delete(document.document.id);
        if (postings.size === 0) this.invertedIndex.delete(token);
      }
    }
  }
}

export function createLocalFallbackVectorProvider(dimensions = 128, tokenizer: Tokenizer = defaultTokenizer): LocalFallbackVectorProvider {
  return new LocalFallbackVectorProvider(dimensions, tokenizer);
}
