import { KeyRing, SecurityError, type KeyRingOptions } from "./index.js";

/** The only key algorithm that the current PREMiSE KeyRing can consume. */
export type ExternalKeyAlgorithm = "aes-256-gcm";

export const EXTERNAL_KEY_MATERIAL_FORMAT = "premise-external-key-material/1" as const;

export interface KeyReference {
  readonly keyId: string;
  /** Provider-native version identifier, normalized as a non-empty printable string. */
  readonly version: string;
  readonly algorithm: ExternalKeyAlgorithm;
  readonly tenantId: string;
}

export interface KeyMaterial extends KeyReference {
  /** Raw 32-byte AES key material. Providers must never log or persist this value unwrapped. */
  readonly material: Uint8Array;
}

/** Provider adapter contract. Network, IAM, KMS and HSM concerns stay outside this package. */
export interface KeyProvider {
  resolve(reference: KeyReference): Promise<KeyMaterial>;
}

export interface ExternalKeyResolverOptions {
  /** Omit only when deliberately constructing a fail-closed, unconfigured resolver. */
  readonly provider?: KeyProvider;
  /** Zero disables caching; production deployments should use a positive, bounded TTL. */
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

export interface KeyRingResolutionOptions {
  readonly tenantId: string;
  readonly active: KeyReference;
  readonly previous?: readonly KeyReference[];
  readonly randomBytes?: KeyRingOptions["randomBytes"];
}

export interface CreateKeyRingFromProviderOptions extends KeyRingResolutionOptions {
  readonly provider: KeyProvider;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

interface NormalizedKeyReference extends KeyReference {}

interface CachedMaterial {
  readonly material: KeyMaterial;
  readonly expiresAt: number;
}

function invalid(message: string): never {
  throw new SecurityError("INVALID_INPUT", message);
}

function configuration(message: string): never {
  throw new SecurityError("CONFIGURATION_ERROR", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printable(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value !== value.trim() || !/^[\x21-\x7e]+$/.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const normalized = printable(value, label, 256);
  if (normalized === "*") invalid(`${label} cannot be a wildcard`);
  return normalized;
}

function version(value: unknown): string {
  const normalized = printable(value, "version", 128);
  if (normalized === "*") invalid("version cannot be a wildcard");
  return normalized;
}

function normalizeReference(input: unknown): NormalizedKeyReference {
  if (!isRecord(input)) invalid("key reference is invalid");
  if (input.algorithm !== "aes-256-gcm") invalid("key reference algorithm is unsupported");
  return Object.freeze({
    keyId: identifier(input.keyId, "keyId"),
    version: version(input.version),
    algorithm: input.algorithm,
    tenantId: identifier(input.tenantId, "tenantId")
  });
}

function cacheKey(reference: KeyReference): string {
  return JSON.stringify([reference.tenantId, reference.algorithm, reference.keyId, reference.version]);
}

function cloneMaterial(material: KeyMaterial): KeyMaterial {
  return Object.freeze({
    keyId: material.keyId,
    version: material.version,
    algorithm: material.algorithm,
    tenantId: material.tenantId,
    material: new Uint8Array(material.material)
  });
}

function normalizeProviderMaterial(expected: NormalizedKeyReference, input: unknown): KeyMaterial {
  try {
    if (!isRecord(input) || !(input.material instanceof Uint8Array) || input.material.length !== 32) throw new Error("invalid material");
    const received = normalizeReference(input);
    if (received.keyId !== expected.keyId || received.version !== expected.version || received.algorithm !== expected.algorithm || received.tenantId !== expected.tenantId) {
      throw new Error("mismatched metadata");
    }
    return cloneMaterial({ ...received, material: input.material });
  } catch {
    configuration("external key provider returned invalid key material");
  }
}

function clock(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch {
    configuration("external key resolver clock is unavailable");
  }
  if (!Number.isFinite(value)) configuration("external key resolver clock is invalid");
  return value;
}

function validateOptions(options: ExternalKeyResolverOptions): { provider?: KeyProvider; cacheTtlMs: number; now: () => number } {
  if (!isRecord(options)) configuration("external key resolver options are invalid");
  const typedOptions = options as ExternalKeyResolverOptions;
  if (typedOptions.provider !== undefined && (!isRecord(typedOptions.provider) || typeof typedOptions.provider.resolve !== "function")) {
    configuration("external key provider is invalid");
  }
  const cacheTtlMs = typedOptions.cacheTtlMs ?? 300_000;
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0) configuration("external key cache TTL is invalid");
  if (typedOptions.now !== undefined && typeof typedOptions.now !== "function") configuration("external key resolver clock is invalid");
  return {
    ...(typedOptions.provider === undefined ? {} : { provider: typedOptions.provider }),
    cacheTtlMs,
    now: typedOptions.now ?? (() => Date.now())
  };
}

function validateResolutionOptions(options: KeyRingResolutionOptions): { tenantId: string; references: readonly NormalizedKeyReference[]; randomBytes?: KeyRingOptions["randomBytes"] } {
  if (!isRecord(options)) invalid("key ring resolution options are invalid");
  const tenantId = identifier(options.tenantId, "tenantId");
  const active = normalizeReference(options.active);
  if (options.previous !== undefined && !Array.isArray(options.previous)) invalid("previous key references are invalid");
  const previous = options.previous ?? [];
  const references = Object.freeze([active, ...previous.map((reference) => normalizeReference(reference))]);
  const keyIds = new Set<string>();
  for (const reference of references) {
    if (reference.tenantId !== tenantId) configuration("key references must use one tenant");
    if (keyIds.has(reference.keyId)) configuration("key references must use unique key identifiers");
    keyIds.add(reference.keyId);
  }
  if (options.randomBytes !== undefined && typeof options.randomBytes !== "function") configuration("key ring random source is invalid");
  return {
    tenantId,
    references,
    ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes })
  };
}

/**
 * Resolves external key material with tenant- and version-bound cache entries.
 * The resolver never logs provider errors or key material and never serves stale material after expiry.
 */
export class ExternalKeyResolver {
  #provider: KeyProvider | undefined;
  #cacheTtlMs: number;
  #now: () => number;
  #cache = new Map<string, CachedMaterial>();
  #inFlight = new Map<string, Promise<KeyMaterial>>();
  #epochs = new Map<string, number>();
  #globalEpoch = 0;

  constructor(options: ExternalKeyResolverOptions = {}) {
    const normalized = validateOptions(options);
    this.#provider = normalized.provider;
    this.#cacheTtlMs = normalized.cacheTtlMs;
    this.#now = normalized.now;
  }

  async resolve(reference: KeyReference): Promise<KeyMaterial> {
    const normalized = normalizeReference(reference);
    const key = cacheKey(normalized);
    const currentTime = clock(this.#now);
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      if (cached.expiresAt > currentTime) return cloneMaterial(cached.material);
      this.#cache.delete(key);
    }

    const inFlight = this.#inFlight.get(key);
    if (inFlight !== undefined) return inFlight.then(cloneMaterial);

    const epoch = this.#epochs.get(key) ?? 0;
    const globalEpoch = this.#globalEpoch;
    const pending = this.#resolveFromProvider(normalized).then((material) => {
      const stillCurrent = this.#globalEpoch === globalEpoch && (this.#epochs.get(key) ?? 0) === epoch;
      if (!stillCurrent) configuration("external key material was invalidated during resolution");
      if (this.#cacheTtlMs > 0) {
        const expiresAt = clock(this.#now) + this.#cacheTtlMs;
        if (Number.isFinite(expiresAt)) this.#cache.set(key, { material: cloneMaterial(material), expiresAt });
      }
      return material;
    });
    this.#inFlight.set(key, pending);
    try {
      return cloneMaterial(await pending);
    } finally {
      if (this.#inFlight.get(key) === pending) this.#inFlight.delete(key);
    }
  }

  /** Explicitly invalidates one tenant/key/version entry before rotation or revocation. */
  invalidate(reference: KeyReference): void {
    const key = cacheKey(normalizeReference(reference));
    this.#cache.delete(key);
    this.#epochs.set(key, (this.#epochs.get(key) ?? 0) + 1);
    this.#inFlight.delete(key);
  }

  /** Invalidates all cached and in-flight entries without attempting a provider call. */
  clear(): void {
    this.#cache.clear();
    this.#inFlight.clear();
    this.#epochs.clear();
    this.#globalEpoch += 1;
  }

  /** Resolves every reference first, then constructs a KeyRing from validated material. */
  async createKeyRing(options: KeyRingResolutionOptions): Promise<KeyRing> {
    const normalized = validateResolutionOptions(options);
    const materials = await Promise.all(normalized.references.map((reference) => this.resolve(reference)));
    const active = materials[0];
    if (active === undefined) configuration("an active key is required");
    return new KeyRing({
      activeKey: { keyId: active.keyId, key: new Uint8Array(active.material) },
      previousKeys: materials.slice(1).map((material) => ({ keyId: material.keyId, key: new Uint8Array(material.material) })),
      ...(normalized.randomBytes === undefined ? {} : { randomBytes: normalized.randomBytes })
    });
  }

  /** Invalidates the requested rotation set and requires a fresh explicit resolution. */
  async rotateKeyRing(options: KeyRingResolutionOptions): Promise<KeyRing> {
    const normalized = validateResolutionOptions(options);
    for (const reference of normalized.references) this.invalidate(reference);
    return this.createKeyRing({
      tenantId: normalized.tenantId,
      active: normalized.references[0] as KeyReference,
      previous: normalized.references.slice(1),
      ...(normalized.randomBytes === undefined ? {} : { randomBytes: normalized.randomBytes })
    });
  }

  async #resolveFromProvider(reference: NormalizedKeyReference): Promise<KeyMaterial> {
    const provider = this.#provider;
    if (provider === undefined) configuration("external key provider is not configured");
    let result: unknown;
    try {
      result = await provider.resolve(reference);
    } catch {
      configuration("external key provider resolution failed");
    }
    return normalizeProviderMaterial(reference, result);
  }
}

/** Safe one-shot factory: no KeyRing is returned until all references resolve and validate. */
export async function createKeyRingFromProvider(options: CreateKeyRingFromProviderOptions): Promise<KeyRing> {
  if (!isRecord(options)) invalid("key ring provider options are invalid");
  const resolver = new ExternalKeyResolver({
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
    ...(options.now === undefined ? {} : { now: options.now })
  });
  return resolver.createKeyRing({
    tenantId: options.tenantId,
    active: options.active,
    ...(options.previous === undefined ? {} : { previous: options.previous }),
    ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes })
  });
}
