import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const localSkill = join(root, ".agents", "skills", "premise");
const pluginSkill = join(root, "plugins", "premise-codex", "skills", "premise");
const pluginRoot = join(root, "plugins", "premise-codex");

const sdkManifest = JSON.parse(await readFile(join(root, "packages", "sdk", "package.json"), "utf8"));
assert.equal(sdkManifest.name, "@premise/sdk");
assert.deepEqual(sdkManifest.dependencies ?? {}, {});
assert.equal(sdkManifest.publishConfig.access, "public");

for (const file of ["SKILL.md", "agents/openai.yaml", "references/contract-map.md", "references/evidence-and-claims.md", "references/integration-checklist.md", "references/protocol-boundary.md"]) {
  const local = await readFile(join(localSkill, file), "utf8");
  const bundled = await readFile(join(pluginSkill, file), "utf8");
  assert.equal(bundled, local, "plugin Skill drift: " + file);
}

const pluginManifest = JSON.parse(await readFile(join(root, "plugins", "premise-codex", ".codex-plugin", "plugin.json"), "utf8"));
assert.equal(pluginManifest.skills, "./skills/");
const mcpManifest = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8"));
assert.equal(mcpManifest.mcpServers.premise.args[0], "./mcp/server.mjs");
assert.equal(mcpManifest.mcpServers.premise.command, "node");
assert.equal(mcpManifest.mcpServers.premise.cwd, ".");
assert.equal(mcpManifest.mcpServers.premise.args.some((arg) => arg.includes("packages/") || arg.includes("workspace:")), false);
await readFile(join(pluginRoot, "mcp", "server.mjs"), "utf8");
await readFile(join(pluginRoot, "mcp", "README.md"), "utf8");
await readFile(join(root, "packages", "mcp-server", "dist", "index.js"), "utf8");

console.log("PREMiSE adoption wave check passed");
