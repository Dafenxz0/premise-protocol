import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(skillRoot, "../../..");
const consumerRoot = join(repoRoot, "adoption", "external-consumers");
const forbidden = /@premise\/(?:runtime-core|protocol-types|adapter-sdk|reference-ts)|workspace:\*|pnpm-workspace\.yaml/u;

assert.equal((await readFile(join(skillRoot, "SKILL.md"), "utf8")).includes("[TODO"), false);
const consumers = (await readdir(consumerRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(consumers, ["filesystem-agent", "github-agent", "rest-agent"]);

for (const consumer of consumers) {
  const files = await readdir(join(consumerRoot, consumer));
  for (const file of files) {
    if (!file.endsWith(".mjs") && !file.endsWith(".json")) continue;
    const content = await readFile(join(consumerRoot, consumer, file), "utf8");
    assert.equal(forbidden.test(content), false, consumer + "/" + file + " imports an internal workspace surface");
  }
}

console.log("PREMiSE public boundary passed");
