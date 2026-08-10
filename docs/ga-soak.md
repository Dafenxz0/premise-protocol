# PREMiSE v2: soak y disponibilidad HTTP

`benchmarks/ga-soak/runner.mjs` mide una instancia desplegada de PREMiSE v2 durante una ventana configurable. Su objetivo es detectar degradación, errores de red, respuestas HTTP incorrectas y fallos semánticos de la API bajo concurrencia. No sustituye una campaña externa, un SLA ni una prueba de recuperación ante fallos.

## Qué hace

Antes de empezar la ventana medida, el runner comprueba el endpoint de readiness, comprueba que la API anuncia `premise/2` y crea algunos registros de preparación en el tenant indicado. Durante la ventana ejecuta solicitudes reales contra `BASE_URL`:

| Operación | Comprobación realizada |
| --- | --- |
| `health` | `GET /readyz` devuelve `ok: true` y, si existe, `ready: true` |
| `capabilities` | `GET /v2/capabilities` anuncia `specVersion: premise/2` |
| `register` | `POST /v2/memories` devuelve `201` y el mismo `memoryId` |
| `retrieve` | `GET /v2/memories/:id` devuelve el registro solicitado |
| `query` | `POST /v2/query` devuelve un objeto `context` |
| `source-changed` | `POST /v2/source-changed` devuelve una lista `affected` |

La lista se puede reducir o repetir con `--operations health,register,retrieve,query`. `register` escribe datos nuevos durante la prueba; usa un tenant y una base de datos de benchmark, y define la política de limpieza del entorno fuera del runner. El runner no borra datos automáticamente.

El header `x-premise-tenant` y el tenant del envelope salen de `PREMISE_TENANT_ID`. Si existe `PREMISE_API_TOKEN`, se envía como `Authorization: Bearer ...`, pero el secreto nunca aparece en el resultado ni en la salida resumida.

## Duración y concurrencia

```powershell
$env:BASE_URL = "http://127.0.0.1:3000"
$env:PREMISE_TENANT_ID = "tenant:ga-soak"
node benchmarks/ga-soak/runner.mjs `
  --duration-ms 30000 `
  --concurrency 4 `
  --request-timeout-ms 30000 `
  --seed-count 4
```

Todas las opciones tienen equivalente de entorno:

| Opción | Variable | Valor por defecto |
| --- | --- | ---: |
| `--duration-ms` | `PREMISE_SOAK_DURATION_MS` | `30000` |
| `--concurrency` | `PREMISE_SOAK_CONCURRENCY` | `4` |
| `--request-timeout-ms` | `PREMISE_SOAK_REQUEST_TIMEOUT_MS` | `30000` |
| `--seed-count` | `PREMISE_SOAK_SEED_COUNT` | `4` |
| `--health-path` | `PREMISE_SOAK_HEALTH_PATH` | `/readyz` |
| `--operations` | `PREMISE_SOAK_OPERATIONS` | todas las operaciones |
| `--output` | `PREMISE_SOAK_OUTPUT` | `benchmarks/ga-soak/results.json` |

Para un servidor `PremiseServer` sin el wrapper operativo se puede usar `--health-path /health`. La URL debe ser HTTP(S); el resultado elimina credenciales, query string y fragmento de la URL antes de guardarla.

## Métricas

El JSON incluye `metrics` y `metrics.byOperation` con:

- `requests`, `successful`, `failed` y `errors.byKind`;
- `availabilityRate = successful / requests`;
- `errorRate = failed / requests`;
- p50, p95 y p99 en milisegundos.

Un resultado solo es exitoso cuando la respuesta es HTTP 2xx y cumple la forma esperada de la operación. Un 503, timeout, JSON inválido o respuesta 2xx semánticamente incorrecta cuenta como fallo. La disponibilidad no se infiere de `/readyz` solamente: incluye todas las operaciones medidas.

Para que el uso de memoria del runner no crezca sin límite, las latencias se guardan en un reservoir uniforme de tamaño configurable (`PREMISE_SOAK_LATENCY_SAMPLE_SIZE`, por defecto `100000`). `latency.observations` es el número total observado y `latency.samples` el tamaño retenido. Los percentiles son de la muestra uniforme, no una promesa de exactitud sobre una distribución infinita.

Cada resultado conserva:

- commit y su procedencia (`env`, `git` o `unavailable`);
- versión de Node;
- plataforma, arquitectura, CPU, paralelismo, memoria total y hostname;
- URL pública del target, tenant, health path, configuración y timestamps.

El hostname puede ser sensible al publicar artefactos: revísalo y redáctalo en una copia pública sin modificar la evidencia original.

## Elegibilidad GA

El resultado siempre contiene `eligibility.eligibleForGa` y `eligibility.classification`. Una ejecución de menos de una hora aparece como `sampleType: smoke` y `classification: smoke-only`, aunque tenga cero errores. Una ejecución larga que no cumpla los gates aparece como `ga-candidate-failed`.

Los gates incorporados son deliberadamente explícitos:

| Gate | Requisito mínimo |
| --- | ---: |
| setup y commit identificable | obligatorio |
| duración medida | `3.600.000 ms` (1 hora) |
| solicitudes medidas | `10.000` |
| observaciones de latencia | `10.000` |
| disponibilidad semántica | `>= 99,9%` |
| tasa de error | `<= 0,1%` |
| p95 global | `<= 500 ms` |
| p99 global | `<= 2.000 ms` |

`--enforce-ga` termina con código distinto de cero si alguno falla. No permite convertir una muestra corta en evidencia GA cambiando un umbral desde la línea de comandos. Una ejecución con disponibilidad perfecta pero cola lenta sigue siendo `ga-candidate-failed`. Aun con `eligibleForGa: true`, el resultado solo respalda ese target, commit, configuración, tenant, hardware y ventana; no prueba una disponibilidad universal ni un SLA.

## Check ejecutable

```powershell
node benchmarks/ga-soak/self-check.mjs
```

El check no afirma evidencia externa: usa un fixture HTTP local, cubre todas las operaciones, comprueba p50/p95/p99, fuerza un fallo controlado y verifica que la muestra queda marcada `smoke-only`. Para evidencia de producción hay que ejecutar el runner contra un despliegue real, conservar el JSON y revisar el entorno, logs, métricas, alertas, dataset, carga y cualquier incidente de la ventana.
