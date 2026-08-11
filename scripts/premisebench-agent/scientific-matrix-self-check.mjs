import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const round = process.argv.find((value) => value.startsWith("--round="))?.slice("--round=".length) || "matrix-dev";
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(round)) throw new Error("--round must be a safe directory name");
const directory = resolve(root, ".tmp/scientific-mvp/matrix", round);
const readJson = async (name) => JSON.parse(await readFile(resolve(directory, name), "utf8"));
const [summary, blind, examined, frontier] = await Promise.all([
  readJson("summary.json"),
  readJson("blind-report.json"),
  readJson("examined-report.json"),
  readJson("frontier.json")
]);

assert.equal(summary.format, "premisebench-agent/scientific-matrix/v1");
assert.equal(summary.taskCount, summary.tasksPerCell * 6 * 4 * 2);
assert.equal(summary.results.length, 6);
assert.equal(blind.results.length, 6);
assert.equal(examined.state, "blind-closed");
assert.equal(frontier.format, "premisebench-agent/scientific-frontier/v1");
assert.equal(summary.frontier.frontier.length, frontier.frontier.length);

const forbidden = /^(?:arm|policy|model|provider|mapping|oracle|winner|mutation|family|risk|volatility)$/iu;
function inspect(value, path = "$") {
  if (Array.isArray(value)) return value.forEach((item, index) => inspect(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.test(key), false, `forbidden field ${path}.${key}`);
    inspect(child, `${path}.${key}`);
  }
}
inspect(blind);
assert.ok(blind.results.every(({ id, metrics }) => typeof id === "string" && metrics && !Object.hasOwn(metrics, "arm")));
console.log(`Scientific matrix self-check: PASS (${summary.taskCount} tasks, ${summary.results.length} candidates)`);
