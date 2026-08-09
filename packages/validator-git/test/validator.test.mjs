import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GitValidator } from "../dist/index.js";

const dir = await mkdtemp(path.join(tmpdir(), "premise-git-"));
const file = path.join(dir, "memory.txt");
const uri = `${pathToFileURL(dir).href}#memory.txt`.replace("file:", "git+file:");
try {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "PREMiSE Test"], { cwd: dir });
  await writeFile(file, "one");
  execFileSync("git", ["add", "memory.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: dir });
  const validator = new GitValidator();
  const first = await validator.validate({ sourceUri: uri, observedAt: "2026-08-09T19:20:00Z" });
  assert.equal(first.result, "UNCHANGED");
  await writeFile(file, "two");
  execFileSync("git", ["add", "memory.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "changed"], { cwd: dir });
  const changed = await validator.validate({ sourceUri: uri, observedAt: "2026-08-09T19:20:00Z", version: first.version, validator: { id: "git", operation: "rev-parse" } });
  assert.equal(changed.result, "CHANGED");
  const missing = await validator.validate({ sourceUri: `${pathToFileURL(dir).href}#missing.txt`.replace("file:", "git+file:"), observedAt: "2026-08-09T19:20:00Z" });
  assert.equal(missing.result, "MISSING");
  console.log("validator-git tests passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
