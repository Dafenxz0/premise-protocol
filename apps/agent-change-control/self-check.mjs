import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const [html, css, app] = await Promise.all([
  readFile(join(root, "index.html"), "utf8"),
  readFile(join(root, "styles.css"), "utf8"),
  readFile(join(root, "app.js"), "utf8")
]);

assert.match(app, /STALE_SOURCE/);
assert.match(html, /Change the source/);
assert.match(css, /\.decision/);
assert.match(app, /state\.phase = "blocked"/);
assert.match(app, /state\.phase = "committed"/);
assert.match(html, /Revalidate &amp; commit/);
console.log("agent-change-control self-check: PASS");
