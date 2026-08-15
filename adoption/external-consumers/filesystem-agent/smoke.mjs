import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PremiseClient } from "@premise/sdk";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method === "POST" && path === "/v2/source-changed") {
    json(response, 202, { affected: ["memory:file:1"] });
    return;
  }
  json(response, 404, { error: "not found" });
});

const folder = await mkdtemp(join(tmpdir(), "premise-external-filesystem-"));
await writeFile(join(folder, "policy.txt"), "allow=read\n", "utf8");
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");

try {
  const file = join(folder, "policy.txt");
  const first = await readFile(file, "utf8");
  await writeFile(file, first + "allow=write\n", "utf8");
  const current = await readFile(file, "utf8");
  assert.notEqual(digest(first), digest(current));

  const client = new PremiseClient({
    baseUrl: "http://127.0.0.1:" + address.port + "/",
    tenantId: "filesystem:demo",
    maxRetries: 0
  });
  const signal = await client.sourceChanged(
    "file://" + file.replaceAll("\\", "/"),
    { scheme: "sha256", token: digest(current) }
  );
  assert.deepEqual(signal.affected, ["memory:file:1"]);
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(folder, { recursive: true, force: true });
}

console.log("external filesystem consumer passed");
