import {
  AUDIT_GENESIS_HASH,
  AUDIT_LOG_FORMAT,
  AUDIT_LOG_VERSION,
  SecurityError,
  canonicalize,
  verifyAuditChain,
  type AuditEntry
} from "./index.js";

/** Storage-neutral durable audit sink contract. */
export interface AuditEntrySink {
  append(entry: AuditEntry): Promise<void>;
  read(): Promise<readonly AuditEntry[]>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface AuditSinkRetentionOptions {
  /** Hard upper bound for the number of entries. The sink never deletes old entries. */
  readonly maxEntries?: number;
  /** Hard upper bound for the UTF-8 file size. The sink never rotates or deletes the file. */
  readonly maxBytes?: number;
}

export interface FileAuditSinkOptions {
  /** Maximum UTF-8 bytes for one NDJSON record, including its newline. */
  readonly maxEntryBytes?: number;
  /** Maximum UTF-8 bytes for the complete audit file. */
  readonly maxFileBytes?: number;
  /** Maximum number of records in the file. */
  readonly maxEntries?: number;
  /** Optional aliases for deployment retention limits. Explicit limits win. */
  readonly retention?: AuditSinkRetentionOptions;
  /** Values that must never occur in a serialized audit entry. */
  readonly secrets?: readonly string[];
  /** Alias for secrets, useful when values come from a secret manager. */
  readonly secretValues?: readonly string[];
}

interface NormalizedFileAuditSinkOptions {
  readonly maxEntryBytes: number;
  readonly maxFileBytes: number;
  readonly maxEntries: number;
  readonly secretValues: readonly string[];
}

interface NodeFsModule {
  readonly constants: {
    readonly O_APPEND: number;
    readonly O_CREAT: number;
    readonly O_RDWR: number;
    readonly O_NOFOLLOW?: number;
  };
  openSync(filePath: string, flags: number, mode?: number): number;
  readFileSync(filePath: string, encoding: "utf8"): string;
  writeSync(fileDescriptor: number, data: Uint8Array): number;
  fsyncSync(fileDescriptor: number): void;
  closeSync(fileDescriptor: number): void;
  fstatSync(fileDescriptor: number): { readonly size: number };
  lstatSync(filePath: string): { isFile(): boolean; isSymbolicLink(): boolean };
  chmodSync(filePath: string, mode: number): void;
}

interface NodeProcessLike {
  getBuiltinModule?(specifier: string): unknown;
}

const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 1_000_000;
const RESTRICTIVE_FILE_MODE = 0o600;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TEXT_PATTERN = /^[\x21-\x7e]+$/u;
const OUTCOMES = new Set(["allow", "deny", "allowed", "denied", "success", "failure"]);
const SENSITIVE_KEY_FRAGMENTS = [
  "secret",
  "token",
  "password",
  "passwd",
  "authorization",
  "cookie",
  "apikey",
  "privatekey",
  "credential",
  "signature"
] as const;

function nodeFs(): NodeFsModule {
  const processLike = (globalThis as { process?: NodeProcessLike }).process;
  const module = processLike?.getBuiltinModule?.("node:fs");
  if (module === undefined) throw new SecurityError("CONFIGURATION_ERROR", "Node filesystem support is unavailable");
  return module as NodeFsModule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function failIntegrity(): never {
  throw new SecurityError("AUDIT_INTEGRITY_ERROR", "Audit sink integrity check failed");
}

function failInput(): never {
  throw new SecurityError("INVALID_INPUT", "Audit sink input is invalid");
}

function failConfiguration(): never {
  throw new SecurityError("CONFIGURATION_ERROR", "Audit sink configuration is invalid");
}

function positiveLimit(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) failConfiguration();
  return value;
}

function byteLength(value: string): number {
  return Buffer.from(value, "utf8").length;
}

function normalizedSecrets(options: FileAuditSinkOptions): readonly string[] {
  const configured = [
    ...(options.secrets ?? []),
    ...(options.secretValues ?? [])
  ];
  if (!configured.every((value) => typeof value === "string" && value.length > 0)) failConfiguration();
  return Object.freeze([...new Set(configured)].sort((left, right) => right.length - left.length));
}

function normalizeOptions(options: FileAuditSinkOptions): NormalizedFileAuditSinkOptions {
  if (!isRecord(options)) failConfiguration();
  const retention = options.retention;
  if (retention !== undefined && !isRecord(retention)) failConfiguration();
  return {
    maxEntryBytes: positiveLimit(options.maxEntryBytes, DEFAULT_MAX_ENTRY_BYTES),
    maxFileBytes: positiveLimit(options.maxFileBytes ?? retention?.maxBytes, DEFAULT_MAX_FILE_BYTES),
    maxEntries: positiveLimit(options.maxEntries ?? retention?.maxEntries, DEFAULT_MAX_ENTRIES),
    secretValues: normalizedSecrets(options)
  };
}

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function containsSecret(value: unknown, secrets: readonly string[], seen = new Set<object>(), key?: string): boolean {
  if (key !== undefined && sensitiveKey(key)) return true;
  if (typeof value === "string") return secrets.some((secret) => value.includes(secret));
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) {
    const found = value.some((item) => containsSecret(item, secrets, seen));
    seen.delete(value);
    return found;
  }
  const found = Object.entries(value).some(([property, child]) => containsSecret(child, secrets, seen, property));
  seen.delete(value);
  return found;
}

function textField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim() && TEXT_PATTERN.test(value);
}

function exactKeys(value: Record<string, unknown>, allowSubject: boolean): boolean {
  const expected = new Set([
    "format",
    "version",
    "sequence",
    "eventId",
    "occurredAt",
    "tenantId",
    ...(allowSubject ? ["subjectId"] : []),
    "action",
    "outcome",
    "data",
    "previousHash",
    "hash"
  ]);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function validateEntryShape(value: unknown): AuditEntry {
  if (!isRecord(value)) failInput();
  const hasSubject = Object.hasOwn(value, "subjectId");
  if (!exactKeys(value, hasSubject)) failInput();
  if (
    value.format !== AUDIT_LOG_FORMAT ||
    value.version !== AUDIT_LOG_VERSION ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) <= 0 ||
    !textField(value.eventId) ||
    !textField(value.occurredAt) ||
    !textField(value.tenantId) ||
    (hasSubject && !textField(value.subjectId)) ||
    !textField(value.action) ||
    typeof value.outcome !== "string" ||
    !OUTCOMES.has(value.outcome) ||
    !Object.hasOwn(value, "data") ||
    (value.previousHash !== AUDIT_GENESIS_HASH && (typeof value.previousHash !== "string" || !HASH_PATTERN.test(value.previousHash))) ||
    typeof value.hash !== "string" ||
    !HASH_PATTERN.test(value.hash)
  ) failInput();
  return value as unknown as AuditEntry;
}

function canonicalEntry(value: unknown, secrets: readonly string[]): { readonly entry: AuditEntry; readonly line: string } {
  const canonical = (() => {
    try {
      return canonicalize(value);
    } catch {
      failInput();
    }
  })();
  let normalized: unknown;
  try {
    normalized = JSON.parse(canonical) as unknown;
  } catch {
    failInput();
  }
  const entry = validateEntryShape(normalized);
  if (containsSecret(entry, secrets)) throw new SecurityError("INVALID_INPUT", "Audit entry contains a secret");
  if (canonicalize(entry) !== canonical) failInput();
  return { entry, line: canonical };
}

function decodeFile(text: string, options: NormalizedFileAuditSinkOptions): AuditEntry[] {
  if (text.length === 0) return [];
  if (!text.endsWith("\n")) failIntegrity();
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) failIntegrity();
  const entries: AuditEntry[] = [];
  const eventIds = new Set<string>();
  const hashes = new Set<string>();
  for (const line of lines) {
    if (byteLength(line) + 1 > options.maxEntryBytes) failIntegrity();
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      failIntegrity();
    }
    let decoded: { readonly entry: AuditEntry; readonly line: string };
    try {
      decoded = canonicalEntry(parsed, options.secretValues);
    } catch (error) {
      if (error instanceof SecurityError && error.code === "INVALID_INPUT") failIntegrity();
      throw error;
    }
    const { entry, line: canonical } = decoded;
    if (canonical !== line || eventIds.has(entry.eventId) || hashes.has(entry.hash)) failIntegrity();
    eventIds.add(entry.eventId);
    hashes.add(entry.hash);
    entries.push(entry);
    if (entries.length > options.maxEntries) failIntegrity();
  }
  if (!verifyAuditChain(entries)) failIntegrity();
  return entries;
}

function freezeDeep(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function cloneEntries(entries: readonly AuditEntry[]): readonly AuditEntry[] {
  const clone = JSON.parse(JSON.stringify(entries)) as AuditEntry[];
  for (const entry of clone) freezeDeep(entry);
  return Object.freeze(clone);
}

function writeAll(fs: NodeFsModule, fileDescriptor: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    const written = fs.writeSync(fileDescriptor, data.subarray(offset));
    if (!Number.isSafeInteger(written) || written <= 0) failIntegrity();
    offset += written;
  }
}

/**
 * Durable local NDJSON sink. It detects tampering; it is not WORM storage.
 * The constructor opens and validates the complete existing chain synchronously.
 */
export class FileAuditSink implements AuditEntrySink {
  readonly #path: string;
  readonly #fs: NodeFsModule;
  readonly #options: NormalizedFileAuditSinkOptions;
  #fileDescriptor = -1;
  #fileBytes = 0;
  #entries: AuditEntry[] = [];
  #closed = false;
  #poisoned = false;

  constructor(filePath: string, options: FileAuditSinkOptions = {}) {
    if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\u0000")) failConfiguration();
    this.#path = filePath;
    this.#options = normalizeOptions(options);
    this.#fs = nodeFs();
    let fileDescriptor = -1;
    try {
      try {
        const existing = this.#fs.lstatSync(filePath);
        if (existing.isSymbolicLink() || !existing.isFile()) failConfiguration();
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      const { O_APPEND, O_CREAT, O_RDWR, O_NOFOLLOW } = this.#fs.constants;
      const noFollow = O_NOFOLLOW === undefined ? 0 : O_NOFOLLOW;
      fileDescriptor = this.#fs.openSync(filePath, O_APPEND | O_CREAT | O_RDWR | noFollow, RESTRICTIVE_FILE_MODE);
      this.#fs.chmodSync(filePath, RESTRICTIVE_FILE_MODE);
      const stat = this.#fs.fstatSync(fileDescriptor);
      if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > this.#options.maxFileBytes) failIntegrity();
      const text = this.#fs.readFileSync(filePath, "utf8");
      if (byteLength(text) !== stat.size) failIntegrity();
      const entries = decodeFile(text, this.#options);
      this.#fileDescriptor = fileDescriptor;
      this.#fileBytes = stat.size;
      this.#entries = entries;
    } catch (error) {
      if (fileDescriptor !== -1) {
        try { this.#fs.closeSync(fileDescriptor); } catch { /* preserve the fail-closed error */ }
      }
      if (error instanceof SecurityError) throw error;
      throw new SecurityError("CONFIGURATION_ERROR", "Audit sink could not be opened");
    }
  }

  static async open(filePath: string, options: FileAuditSinkOptions = {}): Promise<FileAuditSink> {
    return new FileAuditSink(filePath, options);
  }

  #ensureOpen(): void {
    if (this.#closed) throw new SecurityError("CONFIGURATION_ERROR", "Audit sink is closed");
    if (this.#poisoned) failIntegrity();
  }

  #assertFileSize(): void {
    const size = this.#fs.fstatSync(this.#fileDescriptor).size;
    if (size !== this.#fileBytes) failIntegrity();
  }

  async append(input: AuditEntry): Promise<void> {
    this.#ensureOpen();
    this.#assertFileSize();
    const { entry, line } = canonicalEntry(input, this.#options.secretValues);
    const record = `${line}\n`;
    const recordBytes = byteLength(record);
    if (recordBytes > this.#options.maxEntryBytes || this.#entries.length >= this.#options.maxEntries || this.#fileBytes + recordBytes > this.#options.maxFileBytes) failInput();
    const next = [...this.#entries, entry];
    if (this.#entries.some((existing) => existing.eventId === entry.eventId || existing.hash === entry.hash) || !verifyAuditChain(next)) failIntegrity();
    try {
      writeAll(this.#fs, this.#fileDescriptor, Buffer.from(record, "utf8"));
      this.#fs.fsyncSync(this.#fileDescriptor);
    } catch (error) {
      this.#poisoned = true;
      if (error instanceof SecurityError) throw error;
      throw new SecurityError("AUDIT_INTEGRITY_ERROR", "Audit entry could not be durably appended");
    }
    this.#entries.push(entry);
    this.#fileBytes += recordBytes;
  }

  async read(): Promise<readonly AuditEntry[]> {
    this.#ensureOpen();
    this.#assertFileSize();
    return cloneEntries(this.#entries);
  }

  async flush(): Promise<void> {
    this.#ensureOpen();
    try {
      this.#assertFileSize();
      this.#fs.fsyncSync(this.#fileDescriptor);
    } catch (error) {
      this.#poisoned = true;
      if (error instanceof SecurityError) throw error;
      throw new SecurityError("AUDIT_INTEGRITY_ERROR", "Audit sink flush failed");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    let failure: unknown;
    try {
      if (!this.#poisoned) {
        try {
          this.#assertFileSize();
          this.#fs.fsyncSync(this.#fileDescriptor);
        } catch (error) {
          failure = error instanceof SecurityError ? error : new SecurityError("AUDIT_INTEGRITY_ERROR", "Audit sink close flush failed");
        }
      }
    } finally {
      try {
        this.#fs.closeSync(this.#fileDescriptor);
      } catch (error) {
        if (failure === undefined) failure = new SecurityError("CONFIGURATION_ERROR", "Audit sink could not be closed");
        void error;
      }
      this.#closed = true;
    }
    if (failure !== undefined) throw failure;
  }
}
