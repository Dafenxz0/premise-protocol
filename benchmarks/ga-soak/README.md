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

También se pueden configurar `PREMISE_SOAK_DURATION_MS`, `PREMISE_SOAK_CONCURRENCY`, `PREMISE_SOAK_REQUEST_TIMEOUT_MS`, `PREMISE_SOAK_SEED_COUNT`, `PREMISE_SOAK_HEALTH_PATH`, `PREMISE_SOAK_LIVENESS_PATH`, `PREMISE_SOAK_OPERATIONS`, `PREMISE_SOAK_LATENCY_SAMPLE_SIZE`, `PREMISE_SOAK_RAW_TRACE_LIMIT`, `PREMISE_SOAK_TRACE_OUTPUT` y `PREMISE_SOAK_OUTPUT`.

El benchmark escribe `benchmarks/ga-soak/results.json` salvo que se indique `--output PATH`.

La elegibilidad GA se calcula de forma global y por operación. Cada operación
requerida (`health`, `capabilities`, `register`, `retrieve`, `query` y
`source-changed`) debe tener muestras, disponibilidad y percentiles dentro del
contrato. Un resultado corto se clasifica como `smoke-only`; no se convierte
en evidencia GA por tener una media favorable.

Para una campaña auditable, usa `--trace-output PATH`. El runner escribe un
JSONL con request id, respuesta, estado, duración, operación y error, limita el
número de eventos retenidos en memoria y calcula SHA-256 del fichero completo.
El resultado solo afirma lo observado en ese commit, host, configuración y
dataset; no es un SLA universal.

## Diagnostico PostgreSQL y acceptance check

Para conservar evidencia de por que una ventana es lenta, ejecuta el diagnostico
contra la misma base de datos PostgreSQL que usa el target. La conexion solo lee
las vistas `pg_stat_checkpointer` (o `pg_stat_bgwriter` en PostgreSQL 16 y
anteriores), `pg_stat_wal`, `pg_stat_database` y `pg_stat_activity`; no modifica
el store ni la configuracion del servicio.

```powershell
$env:BASE_URL = "http://127.0.0.1:3000"
$env:PREMISE_SOAK_DATABASE_URL = "postgresql://<user>:<password>@127.0.0.1:5432/<db>"
node benchmarks/ga-soak/diagnostic.mjs `
  --duration-ms 3600000 `
  --concurrency 16 `
  --seed-count 16 `
  --output benchmarks/ga-soak/diagnostic-results.json
```

Cada resultado conserva `metrics.byOperation.<operation>.latency` y las
muestras completas en `postgresTelemetry.samples`. `postgresTelemetry.summary`
contiene los deltas de checkpoints, WAL, transacciones, bloques y conexiones.
También conserva la configuración efectiva observada (`checkpoint_timeout`,
`checkpoint_completion_target`, `max_wal_size`, `min_wal_size`,
`wal_compression`, `fsync`, `full_page_writes` y `synchronous_commit`) en
`postgresTelemetry.summary.configuration`. Si esa configuración cambia entre
el primer y el último muestreo, la ventana se clasifica como
`configuration-changed` y no es elegible: una comparación de rendimiento con
configuración mutable no es evidencia reproducible.
Después de comprobar errores, conexiones y latencia, el diagnóstico separa dos
casos. Los checkpoints temporizados por PostgreSQL con `requested=0` y una
fracción pequeña de sincronización se clasifican como `checkpoint-paced`: la
ventana sigue siendo aceptable, pero conserva la telemetría para investigar el
throughput del volumen. Un checkpoint solicitado, sincronización dominante,
errores de I/O o incumplimiento de SLO se clasifica como `storage-blocking` y
termina con código distinto de cero; `acceptance.passed=false` fuerza también
`eligibility.eligibleForGa=false`. No se relaja el gate de errores ni de SLO.

La campaña manual del 2026-08-10 es un ejemplo de diagnóstico, no una señal de
disponibilidad aceptada: completó 587.507 solicitudes sin errores, pero observó
4 checkpoints temporizados (0 solicitados), 2.328.950 ms de escritura y 24 ms de
sync sobre una ventana de 3.600.154,681 ms; 8.515 buffers y 868.260.959 bytes de
WAL. El 64,7% de la ventana quedó ocupado por escritura de checkpoint. Los logs
del mismo contenedor registraron checkpoints de aproximadamente 710-810 s.
La clasificación actual de esa ventana es `checkpoint-paced`: los checkpoints
fueron temporizados (`requested=0`) y la sincronización fue 24 ms frente a
2.328.974 ms totales. Sigue siendo un diagnóstico antiguo, no certificación GA;
el propietario de la investigación es la capa de almacenamiento/configuración
de PostgreSQL (throughput, volumen Docker/runner, cadencia y presupuesto WAL),
no una optimización del gate ni una afirmación de que el protocolo sea
universal. El artefacto conserva `writeTimeMs`,
`syncTimeMs`, `buffers`, `writeTimePerBufferMs` y `walBytesPerRequest` para que
la siguiente ejecución pueda demostrar si el cuello desapareció.

El resultado incluye acciones para revisar la base de datos y repetir la
prueba; no aplica cambios de runtime ni de deployment. Usa `--report-only`
para conservar el artefacto sin hacer fallar el proceso, pero ese resultado
sigue siendo no aceptado y no debe presentarse como evidencia GA.
