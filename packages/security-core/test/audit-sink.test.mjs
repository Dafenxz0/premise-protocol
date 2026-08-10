import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AuditLog,
  AUDIT_LOG_FORMAT,
  AUDIT_LOG_VERSION,
  canonicalize,
  SecurityError
} from "../dist/index.js";
import { FileAuditSink } from "../dist/audit-sink.js";

const temporaryDirectories = [];
const makeDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "premise-audit-sink-"));
  temporaryDirectories.push(directory);
  return directory;
};

const cleanup = async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
};

try {
  const directory = await makeDirectory();
  const filePath = path.join(directory, "audit.ndjson");
  const secret = "audit-secret-value-that-must-not-be-written";
  const source = new AuditLog({
    now: () => "2026-08-10T10:00:00.000Z",
    eventIdGenerator: (() => { let id = 0; return () => `audit-${++id}`; })()
  });
  const first = source.append({ tenantId: "tenant:acme", subjectId: "subject:alice", action: "memory.read", outcome: "allow", data: { result: "ok" } });
  const second = source.append({ tenantId: "tenant:acme", subjectId: "subject:alice", action: "memory.write", outcome: "success", data: { result: "stored" } });
  const sink = await FileAuditSink.open(filePath);
  await sink.append(first);
  await sink.append(second);
  await sink.flush();
  assert.deepEqual(await sink.read(), [first, second]);
  const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
  assert.deepEqual(lines, [canonicalize(first), canonicalize(second)], "records must be canonical NDJSON");
  if (process.platform !== "win32") assert.equal((await stat(filePath)).mode & 0o777, 0o600, "audit files must not be group/world readable");
  await sink.close();

  const reopened = new FileAuditSink(filePath);
  assert.deepEqual(await reopened.read(), [first, second], "a reopened sink must validate and recover the chain");
  await reopened.close();

  const expectIntegrityFailure = async (target, message) => {
    await assert.rejects(() => FileAuditSink.open(target), (error) => {
      assert.equal(error instanceof SecurityError, true, message);
      assert.equal(error.code, "AUDIT_INTEGRITY_ERROR", message);
      return true;
    });
  };

  const truncatedPath = path.join(directory, "truncated.ndjson");
  await writeFile(truncatedPath, `${canonicalize(first)}\n${canonicalize(second)}`, "utf8");
  await expectIntegrityFailure(truncatedPath, "a truncated final line must fail closed");

  const reorderedPath = path.join(directory, "reordered.ndjson");
  await writeFile(reorderedPath, `${canonicalize(second)}\n${canonicalize(first)}\n`, "utf8");
  await expectIntegrityFailure(reorderedPath, "reordered records must fail closed");

  const duplicatePath = path.join(directory, "duplicate.ndjson");
  await writeFile(duplicatePath, `${canonicalize(first)}\n${canonicalize(first)}\n`, "utf8");
  await expectIntegrityFailure(duplicatePath, "duplicate records must fail closed");

  const secretPath = path.join(directory, "secret.ndjson");
  const secretLog = new AuditLog({ now: () => "2026-08-10T10:00:00.000Z", eventIdGenerator: () => "secret-event" });
  const secretEntry = secretLog.append({ tenantId: "tenant:acme", action: "memory.read", outcome: "allow", data: { note: secret } });
  const secretSink = await FileAuditSink.open(secretPath, { secrets: [secret] });
  await assert.rejects(() => secretSink.append(secretEntry), (error) => error instanceof SecurityError && error.code === "INVALID_INPUT");
  await secretSink.close();
  assert.equal((await readFile(secretPath, "utf8")), "", "rejected secrets must never reach disk");

  const limitedPath = path.join(directory, "limited.ndjson");
  const limited = await FileAuditSink.open(limitedPath, { maxEntries: 1, maxEntryBytes: 4096, maxFileBytes: 8192 });
  await limited.append(first);
  await assert.rejects(() => limited.append(second), (error) => error instanceof SecurityError && error.code === "INVALID_INPUT");
  await limited.close();

  const invalidLinePath = path.join(directory, "invalid-line.ndjson");
  await writeFile(invalidLinePath, `${JSON.stringify({ version: AUDIT_LOG_VERSION, format: AUDIT_LOG_FORMAT })}\n`, "utf8");
  await expectIntegrityFailure(invalidLinePath, "invalid records must fail closed");

  const closedPath = path.join(directory, "closed.ndjson");
  const closed = await FileAuditSink.open(closedPath);
  await closed.close();
  await assert.rejects(() => closed.read(), (error) => error instanceof SecurityError && error.code === "CONFIGURATION_ERROR");

  console.log("security-core durable audit sink tests passed");
} finally {
  await cleanup();
}
