import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FilesystemValidator } from "../dist/index.js";

const dir = await mkdtemp(path.join(tmpdir(), "premise-fs-"));
const file = path.join(dir, "memory.txt");
const uri = pathToFileURL(file).href;
try {
  await writeFile(file, "one");
  const validator = new FilesystemValidator();
  const first = await validator.validate({ sourceUri: uri, observedAt: "2026-08-09T19:20:00Z" });
  assert.equal(first.result, "UNCHANGED");
  await writeFile(file, "two");
  const changed = await validator.validate({ sourceUri: uri, observedAt: "2026-08-09T19:20:00Z", version: first.version, validator: { id: "filesystem", operation: "sha256" } });
  assert.equal(changed.result, "CHANGED");
  await rm(file);
  const missing = await validator.validate({ sourceUri: uri, observedAt: "2026-08-09T19:20:00Z", version: first.version, validator: { id: "filesystem", operation: "sha256" } });
  assert.equal(missing.result, "MISSING");
  console.log("validator-filesystem tests passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
