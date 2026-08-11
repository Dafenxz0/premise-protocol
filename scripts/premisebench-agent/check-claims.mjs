import { readFile } from "node:fs/promises";

const [manifest, design, docs] = await Promise.all([
  readFile("benchmarks/premisebench-agent/manifest.json", "utf8"),
  readFile("benchmarks/premisebench-agent/DESIGN.md", "utf8"),
  readFile("docs/benchmarks/premisebench-agent.md", "utf8")
]);
for (const [name, text] of [["manifest", manifest], ["design", design], ["docs", docs]]) {
  if (!text.includes("NOT_RUN")) throw new Error(`${name} must preserve the NOT_RUN rule`);
}
if (!manifest.includes("deterministic-control")) throw new Error("manifest must label the smoke provider");
if (!design.includes("holdout") || !design.includes("200")) throw new Error("design must freeze holdout and minimum campaign size");
const publicText = docs.toLowerCase();
if (!publicText.includes("model") && !publicText.includes("modelo")) throw new Error("public docs must separate smoke from model evidence");
console.log("PremiseBench-Agent claims check: PASS");
