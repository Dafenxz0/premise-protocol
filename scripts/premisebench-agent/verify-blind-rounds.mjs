import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? path.join(here, "../../benchmarks/premisebench-agent/artifacts/real-campaign"));
const rounds = ["round-0", "round-1", "round-2", "round-3"];
const forbiddenKeys = new Set([
  "label", "labels", "strategy", "strategyName", "strategyId", "variant", "variantName", "variantId",
  "policy", "policyName", "policyId", "baseline", "baselineName", "baselineId", "arm", "treatment",
  "condition", "cohort", "provider", "model", "systemPrompt", "temperature"
]);
const modelClaim = /(?:benchmark|benchmarks|benchmarking|informe|resultado|evidencia).{0,50}(?:modelo(?:s)?|model(?:s)?).{0,50}(?:real(?:es)?|producci[oó]n|provider|proveedor)|(?:modelo(?:s)?|model(?:s)?).{0,50}(?:benchmark|benchmarks|benchmarking).{0,50}(?:real(?:es)?|producci[oó]n)/iu;

function fail(message) {
  throw new Error(`Blind rounds verifier: ${message}`);
}

function inspectKeys(value, location = "$") {
  if (Array.isArray(value)) return value.forEach((child, index) => inspectKeys(child, `${location}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (!(location === "$" && (key === "labels" || key === "emitsStrategyLabels")) && forbiddenKeys.has(key)) {
      fail(`${location}.${key} emits a blind label or provider identity`);
    }
    inspectKeys(child, `${location}.${key}`);
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    fail(`${path.relative(process.cwd(), file)} is missing or invalid JSON (${error.message})`);
  }
}

for (const round of rounds) {
  const directory = path.join(root, round);
  const jsonFile = path.join(directory, "blind-report.json");
  const markdownFile = path.join(directory, "blind-report.md");
  const report = await readJson(jsonFile);
  let markdown;
  try {
    markdown = await readFile(markdownFile, "utf8");
  } catch (error) {
    fail(`${path.relative(process.cwd(), markdownFile)} is missing (${error.message})`);
  }

  if (report.taskCount !== 14) fail(`${round} must contain exactly 14 tasks`);
  if (!Array.isArray(report.results) || report.results.length !== 3) fail(`${round} must contain exactly three anonymous results`);
  if (report.labels !== "withheld" || report.emitsStrategyLabels !== false) fail(`${round} must withhold labels and emit none`);
  if (!markdown.includes("unknown")) fail(`${round} Markdown must preserve unknown token telemetry`);
  if (modelClaim.test(markdown)) fail(`${round} claims benchmark evidence for real models`);

  const ids = report.results.map((result) => result.id);
  if (ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(id))) fail(`${round} has an invalid anonymous ID`);
  if (new Set(ids).size !== 3) fail(`${round} anonymous IDs are not unique`);
  for (const result of report.results) {
    if (result.metrics?.taskCount !== 14) fail(`${round}/${result.id} must contain 14 tasks`);
    if (result.metrics?.tokenTelemetry !== "unknown" || result.metrics?.tokens !== null || result.metrics?.tokensPerTask !== null) {
      fail(`${round}/${result.id} must keep token telemetry unknown`);
    }
  }
  inspectKeys(report);
  console.log(`${round}: PASS`);
}

console.log("Blind rounds verifier: PASS (rounds 0-3 preserve 14 tasks, 3 anonymous IDs, withheld labels, unknown tokens, and bounded claims)");
