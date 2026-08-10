const baseUrl = process.env.PREMISE_HEALTH_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
const path = process.env.PREMISE_HEALTH_PATH ?? "/health";
const timeoutMs = Number.parseInt(process.env.PREMISE_HEALTH_TIMEOUT_MS ?? "2500", 10);

try {
  const response = await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`health status ${response.status}`);
  const body = await response.json();
  if (body?.ok !== true) throw new Error("health response was not ok");
} catch (error) {
  console.error(`PREMiSE healthcheck failed: ${error?.name ?? "request error"}`);
  process.exitCode = 1;
}
