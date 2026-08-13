const DEFAULT_SCHEME = "deterministic.source";
const DEFAULT_VERSION_TOKEN = "v1";
const DEFAULT_NOW = "2026-08-13T00:00:00.000Z";

function cloneJson(value) {
  return structuredClone(value);
}

function assertObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

function normalizeVersion(value, fallbackScheme = DEFAULT_SCHEME, fallbackToken = DEFAULT_VERSION_TOKEN) {
  if (value === undefined) return Object.freeze({ scheme: fallbackScheme, token: fallbackToken });
  if (typeof value === "string") return Object.freeze({ scheme: fallbackScheme, token: value });
  assertObject(value, "version");
  assertNonEmptyString(value.scheme, "version.scheme");
  assertNonEmptyString(value.token, "version.token");
  return Object.freeze({ scheme: value.scheme, token: value.token });
}

function sameVersion(left, right) {
  return left.scheme === right.scheme && left.token === right.token;
}

function operation(instrumentation, field, count = 1) {
  if (count === 0) return;
  try {
    instrumentation?.onOperation?.({ field, count });
  } catch {
    // Adapter telemetry is observational and cannot affect validation.
  }
}

/**
 * Small in-process source with explicit versions. It has no clock, network or
 * filesystem dependency, so the same task produces the same physical reads.
 */
export class DeterministicMutableSourceAdapter {
  #sources = new Map();
  #instrumentation;
  #now;
  #reads = 0;

  constructor(options = {}) {
    assertObject(options, "options");
    this.#instrumentation = options.instrumentation;
    const now = options.now ?? DEFAULT_NOW;
    this.#now = typeof now === "function" ? now : () => now;
    if (Array.isArray(options.sources)) {
      for (const source of options.sources) {
        assertObject(source, "source");
        this.register(source.sourceUri, source);
      }
    } else if (options.sources !== undefined) {
      assertObject(options.sources, "sources");
      for (const [sourceUri, source] of Object.entries(options.sources)) this.register(sourceUri, source);
    }
  }

  get readCount() {
    return this.#reads;
  }

  has(sourceUri) {
    return this.#sources.has(sourceUri);
  }

  register(sourceUri, initial = {}) {
    assertNonEmptyString(sourceUri, "sourceUri");
    assertObject(initial, "initial source state");
    if (this.#sources.has(sourceUri)) throw new Error(`Source already registered: ${sourceUri}`);
    const version = normalizeVersion(
      initial.version ?? initial.versionToken,
      initial.scheme ?? DEFAULT_SCHEME,
      initial.versionToken ?? DEFAULT_VERSION_TOKEN
    );
    const state = {
      sourceUri,
      version,
      value: cloneJson(initial.value === undefined ? null : initial.value),
      revision: 0
    };
    this.#sources.set(sourceUri, state);
    return this.current(sourceUri);
  }

  current(sourceUri) {
    const state = this.#sources.get(sourceUri);
    return state === undefined ? undefined : Object.freeze(cloneJson(state));
  }

  mutate(sourceUri, change = {}) {
    assertNonEmptyString(sourceUri, "sourceUri");
    if (typeof change === "string") change = { token: change };
    assertObject(change, "change");
    const state = this.#sources.get(sourceUri);
    if (state === undefined) throw new Error(`Unknown source: ${sourceUri}`);
    const nextVersion = normalizeVersion(
      change.version ?? change.versionToken ?? change.token,
      change.scheme ?? state.version.scheme,
      `v${state.revision + 2}`
    );
    state.version = nextVersion;
    if (Object.prototype.hasOwnProperty.call(change, "value")) state.value = cloneJson(change.value);
    state.revision += 1;
    const eventId = change.eventId ?? `source-change:${sourceUri}:${nextVersion.scheme}:${nextVersion.token}`;
    return Object.freeze({ sourceUri, version: nextVersion, eventId });
  }

  remove(sourceUri) {
    assertNonEmptyString(sourceUri, "sourceUri");
    return this.#sources.delete(sourceUri);
  }

  read(evidence, record) {
    assertObject(evidence, "evidence");
    assertObject(record, "record");
    assertObject(record.envelope, "record.envelope");
    assertNonEmptyString(evidence.sourceUri, "evidence.sourceUri");
    assertNonEmptyString(record.envelope.memoryId, "record.envelope.memoryId");
    this.#reads += 1;
    operation(this.#instrumentation, "sourceReads");
    if (evidence.version === undefined) operation(this.#instrumentation, "authoritativeReads");
    else operation(this.#instrumentation, "conditionalReads");

    const state = this.#sources.get(evidence.sourceUri);
    const checkedAt = this.#now();
    if (state === undefined) {
      return Object.freeze({
        memoryId: record.envelope.memoryId,
        result: "MISSING",
        status: "INVALID",
        checkedAt,
        sourceUri: evidence.sourceUri,
        evidenceId: evidence.evidenceId,
        reason: "source is not present"
      });
    }
    const unchanged = evidence.version === undefined || sameVersion(evidence.version, state.version);
    return Object.freeze({
      memoryId: record.envelope.memoryId,
      result: unchanged ? "UNCHANGED" : "CHANGED",
      status: unchanged ? "FRESH" : "INVALID",
      checkedAt,
      sourceUri: evidence.sourceUri,
      evidenceId: evidence.evidenceId,
      ...(unchanged ? { version: state.version } : {}),
      ...(unchanged ? {} : { reason: "source version changed" })
    });
  }

  validator() {
    return (evidence, record) => this.read(evidence, record);
  }

  snapshot() {
    return Object.freeze([...this.#sources.values()]
      .sort((left, right) => left.sourceUri.localeCompare(right.sourceUri))
      .map((state) => Object.freeze(cloneJson(state))));
  }
}

export const DETERMINISTIC_SOURCE_VERSION_SCHEME = DEFAULT_SCHEME;
