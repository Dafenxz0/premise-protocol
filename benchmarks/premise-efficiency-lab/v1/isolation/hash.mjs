import { createHash } from "node:crypto";

export const SHA256_PREFIX = "sha256:";
export const GENESIS_HASH = "sha256:genesis";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function fail(message) {
  throw new TypeError(message);
}

function canonicalFragment(value, stack) {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number": {
      if (!Number.isFinite(value)) fail("canonical JSON cannot contain a non-finite number");
      return JSON.stringify(value);
    }
    case "undefined":
      fail("canonical JSON cannot contain undefined");
      break;
    case "bigint":
    case "symbol":
    case "function":
      fail(`canonical JSON cannot contain ${typeof value}`);
      break;
    default:
      break;
  }

  if (stack.has(value)) fail("canonical JSON cannot contain a cycle");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (Object.getOwnPropertySymbols(value).length > 0 || keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        fail("canonical JSON arrays cannot contain holes or extra properties");
      }
      return `[${value.map((item) => canonicalFragment(item, stack)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail("canonical JSON objects must be plain objects");
    if (Object.getOwnPropertySymbols(value).length > 0) fail("canonical JSON objects cannot contain symbol keys");
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalFragment(value[key], stack)}`).join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

/** Return deterministic JSON with recursively sorted object keys. */
export function canonicalJson(value) {
  return canonicalFragment(value, new Set());
}

export const canonicalize = canonicalJson;
export const stableJson = canonicalJson;

export function sha256Bytes(value) {
  if (!(typeof value === "string" || value instanceof Uint8Array)) {
    throw new TypeError("sha256Bytes expects text or bytes");
  }
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Text(value) {
  if (typeof value !== "string") throw new TypeError("sha256Text expects a string");
  return sha256Bytes(value);
}

export function sha256Json(value) {
  return sha256Text(canonicalJson(value));
}

export function sha256(value) {
  return typeof value === "string" || value instanceof Uint8Array ? sha256Bytes(value) : sha256Json(value);
}

export function sha256Digest(value) {
  return `${SHA256_PREFIX}${sha256(value)}`;
}

export const digest = sha256Digest;

export function assertHash(value, label = "hash") {
  if (value !== GENESIS_HASH && (typeof value !== "string" || !DIGEST_PATTERN.test(value))) {
    throw new TypeError(`${label} must be ${GENESIS_HASH} or a lowercase SHA-256 digest`);
  }
  return value;
}

function assertChainRecord(value, label = "record") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.hasOwn(value, "previousHash") || Object.hasOwn(value, "hash")) {
    throw new TypeError(`${label} must not contain chain fields`);
  }
  canonicalJson(value);
  return value;
}

/** Hash one record together with the hash of its predecessor. */
export function chainHash(previousHash, record) {
  assertHash(previousHash, "previousHash");
  assertChainRecord(record);
  return sha256Digest({ previousHash, record });
}

export const hashChainRecord = chainHash;

/** Add previousHash/hash fields to a sequence of canonical chain records. */
export function hashChain(records, { genesis = GENESIS_HASH } = {}) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  assertHash(genesis, "genesis");
  let previousHash = genesis;
  return records.map((record, index) => {
    assertChainRecord(record, `records[${index}]`);
    const hash = chainHash(previousHash, record);
    const entry = { ...record, previousHash, hash };
    previousHash = hash;
    return entry;
  });
}

/** Return false for any malformed, reordered, or tampered chain. */
export function verifyHashChain(records, { genesis = GENESIS_HASH } = {}) {
  if (!Array.isArray(records)) return false;
  try {
    assertHash(genesis, "genesis");
    let previousHash = genesis;
    for (const [index, entry] of records.entries()) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
      if (entry.previousHash !== previousHash || typeof entry.hash !== "string") return false;
      assertHash(entry.hash, `records[${index}].hash`);
      const { previousHash: ignoredPreviousHash, hash: ignoredHash, ...record } = entry;
      void ignoredPreviousHash;
      void ignoredHash;
      if (chainHash(previousHash, record) !== entry.hash) return false;
      previousHash = entry.hash;
    }
    return true;
  } catch {
    return false;
  }
}

export function assertHashChain(records, options = {}) {
  if (!verifyHashChain(records, options)) throw new TypeError("invalid SHA-256 hash chain");
  return records;
}
