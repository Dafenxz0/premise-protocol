import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const expectedVersion = "2.0.0-rc.2";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const rootManifest = await readJson(join(root, "package.json"));
const sdkManifest = await readJson(join(root, "packages", "sdk", "package.json"));
const readme = await readFile(join(root, "README.md"), "utf8");

assert.equal(rootManifest.version, expectedVersion);
assert.equal(sdkManifest.version, expectedVersion);
assert.equal(rootManifest.license, "Apache-2.0");
assert.equal(sdkManifest.license, "Apache-2.0");
assert.equal(rootManifest.bin?.["premise-install"], "plugins/premise-codex/install.mjs");
assert.ok(rootManifest.files?.includes("plugins/premise-codex"));
assert.ok(rootManifest.files?.includes("LICENSE"));
assert.match(readme, /PREMiSE 2 is the current candidate protocol/u);
assert.match(readme, /`premise\/2`/u);
assert.match(readme, /`premise\/1` and `premise\/1\.1` are frozen/u);
assert.match(readme, /PREMiSE NEXT/u);
assert.match(readme, /premise-install/u);
await access(join(root, "LICENSE"));

console.log(JSON.stringify({
  status: "PASS",
  version: expectedVersion,
  protocol: "premise/2",
  license: "Apache-2.0",
  installer: "premise-install",
  sbom: "release:sbom"
}, null, 2));
