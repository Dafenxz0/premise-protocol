# PREMiSE v2 soak benchmark

Este benchmark genera tráfico HTTP real contra `BASE_URL`. Comprueba readiness, capacidades y operaciones v2 (`register`, `retrieve`, `query` y `source-changed`) con varias solicitudes concurrentes. No usa un store sintético para las métricas de disponibilidad.

## Smoke local

El runner dura 30 segundos por defecto y se marca siempre como `smoke-only` porque una prueba corta no puede demostrar disponibilidad GA:

```powershell
node benchmarks/ga-soak/runner.mjs --base-url http://127.0.0.1:3000
node benchmarks/ga-soak/self-check.mjs
```

El `self-check` levanta un servidor HTTP local, ejercita todas las rutas y fuerza un error 503 para verificar que el runner no confunde un HTTP fallido con disponibilidad.

## Campaña larga

Para una campaña real, usa un tenant dedicado y conserva el JSON junto con el commit, la configuración del despliegue y el host:

```powershell
$env:BASE_URL = "https://premise-staging.example"
$env:PREMISE_TENANT_ID = "tenant:ga-soak"
$env:PREMISE_API_TOKEN = "<inyectar-desde-secret-manager>"
node benchmarks/ga-soak/runner.mjs `
  --duration-ms 3600000 `
  --concurrency 16 `
  --seed-count 16 `
  --enforce-ga
```

`--enforce-ga` solo debe usarse en el job que realmente quiera exigir la muestra mínima. El token nunca se escribe en el resultado; únicamente se registra `authorizationConfigured: true|false`.

También se pueden configurar `PREMISE_SOAK_DURATION_MS`, `PREMISE_SOAK_CONCURRENCY`, `PREMISE_SOAK_REQUEST_TIMEOUT_MS`, `PREMISE_SOAK_SEED_COUNT`, `PREMISE_SOAK_HEALTH_PATH`, `PREMISE_SOAK_OPERATIONS`, `PREMISE_SOAK_LATENCY_SAMPLE_SIZE` y `PREMISE_SOAK_OUTPUT`.

El benchmark escribe `benchmarks/ga-soak/results.json` salvo que se indique `--output PATH`.
