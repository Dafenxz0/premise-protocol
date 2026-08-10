import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.ok(Number.isInteger(port));
  return port;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
  if (child.exitCode === null) child.kill();
}

async function prepareWorkspacePackageLinks() {
  const premiseDirectory = path.join(repositoryRoot, "node_modules", "@premise");
  await mkdir(premiseDirectory, { recursive: true });
  const packages = ["context-engine", "index-hybrid", "premise-server", "protocol-types", "reference-ts", "runtime-core", "store-postgres"];
  const created = [];
  for (const packageName of packages) {
    const link = path.join(premiseDirectory, packageName);
    try {
      await lstat(link);
      continue;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const target = path.join(repositoryRoot, "packages", packageName);
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    created.push(link);
  }
  return async () => {
    for (const link of created) await rm(link, { recursive: true, force: true });
    if (created.length > 0) await rm(premiseDirectory, { recursive: false, force: true }).catch(() => undefined);
  };
}

test("production metrics and readiness routes enforce their intended boundaries", async () => {
  const cleanupWorkspaceLinks = await prepareWorkspacePackageLinks();
  const port = await freePort();
  const apiToken = "api-token-0123456789abcdef0123456789";
  const metricsToken = "metrics-token-0123456789abcdef012345";
  const child = spawn(process.execPath, ["ops/server.mjs"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PREMISE_ENV: "production",
      PREMISE_STORE_MODE: "memory",
      PREMISE_TENANT_ID: "tenant:route-test",
      PREMISE_API_TOKEN: apiToken,
      PREMISE_METRICS_TOKEN: metricsToken
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  let started = false;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start: ${stdout}\n${stderr}`)), 10_000);
      const onData = () => {
        if (!stdout.includes(`PREMiSE v2 listening on 127.0.0.1:${port}`)) return;
        clearTimeout(timer);
        started = true;
        resolve();
      };
      child.stdout.on("data", onData);
      child.once("exit", (code, signal) => {
        if (!started) {
          clearTimeout(timer);
          reject(new Error(`server exited before start (${code ?? signal}): ${stdout}\n${stderr}`));
        }
      });
    });

    const url = (route) => `http://127.0.0.1:${port}${route}`;
    const request = (route, authorization = undefined) => fetch(url(route), {
      signal: AbortSignal.timeout(2_000),
      ...(authorization === undefined ? {} : { headers: { authorization: `Bearer ${authorization}` } })
    });

    const metricsWithoutToken = await request("/metrics");
    assert.equal(metricsWithoutToken.status, 401);
    assert.equal((await metricsWithoutToken.json()).error, "unauthorized");

    const metricsWithApiToken = await request("/metrics", apiToken);
    assert.equal(metricsWithApiToken.status, 401, "the API token must not authorize metrics");

    const metricsWithMetricsToken = await request("/metrics", metricsToken);
    assert.equal(metricsWithMetricsToken.status, 200);
    assert.match(await metricsWithMetricsToken.text(), /premise_build_info/);

    const readiness = await request("/readyz");
    assert.equal(readiness.status, 200, "the container loopback healthcheck must remain usable");
    assert.equal((await readiness.json()).ready, true);
  } finally {
    await stop(child);
    await cleanupWorkspaceLinks();
  }
});
