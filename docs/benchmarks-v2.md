# PREMiSE v2: cómo leer los benchmarks

Este documento explica qué mide PREMiSE v2, qué significa cada número y qué no
se puede prometer todavía. La regla principal es sencilla: una fixture local
sirve para detectar regresiones; una observación externa sirve para comprobar
que un conector funciona; ninguna de las dos, por sí sola, convierte PREMiSE
en una solución universal.

## La tabla principal

`benchmarks/real-world-v2` ejecuta las mismas tareas contra tres estrategias
emparejadas:

| Estrategia | Qué representa | Qué no representa |
|---|---|---|
| `direct-read` | Control que lee la fuente en cada tarea | No es una memoria ni una mejora de coste |
| `ttl-cache-20` | Baseline sin protocolo: reutiliza una respuesta durante 20 posiciones | No tiene invalidación por cambios de fuente |
| `premise-event-cache` / `premise-conditional-cache` | Referencia de invalidación o validación del protocolo | No es un adapter de producción completo |

El baseline no se elige para que PREMiSE gane: debe quedar expuesto cuando una
fuente cambia. El benchmark offline fuerza mutaciones en las tareas 40 y 70 y
el `self-check` exige que el TTL pierda frescura. Si el baseline nunca falla,
la suite no está ejerciendo el caso que pretende medir.

## Qué significa cada número

- **Precise / 100:** respuestas exactamente iguales a la label del evaluador.
  Una tarea con error cuenta como incorrecta; no se elimina del denominador.
- **Fresh / 100:** además de acertar, la versión observada de la fuente coincide
  con la versión vigente. En una fuente que no expone versión, la métrica debe
  quedar no disponible, no convertirse en un 100% inventado.
- **Requests / 100:** solicitudes al conector por cada 100 tareas. Es un proxy
  comprensible de coste y tráfico.
- **Response bytes / 100:** bytes de respuesta observados por cada 100 tareas.
  En la fixture son bytes serializados localmente y no deben interpretarse como
  egress real.
- **p50/p95/p99:** latencia de la decisión completa de cada tarea. Son
  mediciones del host y del conector de esa ejecución, no un SLA.
- **Errors / 100:** errores de transporte, timeout o ejecución. No se ocultan
  como respuestas incorrectas.

No se publica un precio USD salvo que exista una fuente de facturación o de
infraestructura medida. El runner deja `estimatedUsd: null` y marca
`billingEvidence: false` cuando solo puede contar requests y bytes.

## Ejecuciones reproducibles

Fixture local, apta para CI:

```powershell
node benchmarks/real-world-v2/runner.mjs --offline --seed=premise-v2-real-world-v1
node benchmarks/real-world-v2/report.mjs
node benchmarks/real-world-v2/self-check.mjs
```

Esta ejecución genera:

- `benchmarks/real-world-v2/tasks.json`: tareas públicas sin respuestas.
- `benchmarks/real-world-v2/results.json`: métricas, límites y compromisos.
- `benchmarks/real-world-v2/traces.jsonl`: una línea por estrategia y tarea.
- `benchmarks/real-world-v2/report.md`: tabla legible.

El resultado incluye SHA-256 del manifiesto de tareas y del JSONL completo. El
compromiso SHA-256 de labels permite detectar que el conjunto evaluado cambió,
pero no es una atestación independiente: la label sigue estando en el mismo
proceso evaluador.

## GitHub real, solo lectura

```powershell
$env:PREMISE_GITHUB_REPO = "owner/repository"
$env:GITHUB_TOKEN = "<token de solo lectura>"
node benchmarks/real-world-v2/runner.mjs --live --repetitions=20 --seed=premise-v2-github-v1
node benchmarks/real-world-v2/report.mjs
node benchmarks/real-world-v2/self-check.mjs
```

También se puede ejecutar la misma campaña emparejada contra varios
repositorios reales:

```powershell
$env:PREMISE_GITHUB_REPOS = "Dafenxz0/forgeboard,Dafenxz0/pando,Dafenxz0/riceme-readme-generator"
$env:GITHUB_TOKEN = "<token de solo lectura>"
node benchmarks/real-world-v2/runner.mjs --live --repetitions=20 --seed=premise-v2-github-multi-v1
node benchmarks/real-world-v2/report.mjs
node benchmarks/real-world-v2/self-check.mjs
```

La campaña hace peticiones `GET` reales al API de GitHub, registra status,
ETag, hashes del cuerpo, rate-limit y latencia, y nunca modifica el repositorio.
Los endpoints que no existen se excluyen de forma explícita; si quedan menos de
dos, la ejecución falla. Una campaña de lectura no demuestra recuperación tras
una mutación: para eso hace falta una fuente controlada, varias observaciones
con versiones distintas y un conjunto de labels independiente.

## PostgreSQL real, opt-in y fail-closed

La comprobación del conector no se ejecuta por defecto y no crea tablas ni
escribe datos:

```powershell
$env:PREMISE_BENCHMARK_POSTGRES_URL = "postgresql://<role-readonly>:<password>@host:5432/db"
$env:PREMISE_BENCHMARK_POSTGRES_EVENT_TABLE = "premise_v2_events"
node benchmarks/real-world-v2/runner.mjs --live --postgres
```

El pack usa `BEGIN TRANSACTION READ ONLY`, `SHOW`, `current_setting`,
`pg_database_size`, `to_regclass` y, solo si existe, un `COUNT` de la tabla
declarada. El identificador de tabla se valida y el valor de la relación se
parametriza. El benchmark falla si falta el driver, la URL o una consulta
obligatoria; no convierte una conexión rota en `0 errores`.

Esto es evidencia de conectividad/seguridad de lectura, no una prueba de
capacidad de escritura ni de eficacia de PREMiSE. Para carga y recuperación
real de PostgreSQL deben usarse además `benchmarks/ga-load` y la infraestructura
de producción-shaped.

## Ciego, externo e independiente no son sinónimos

La suite `real-world-v2` es ciega en el sentido de que el manifiesto público no
contiene respuestas y las trazas no contienen `answer`, `expected`, `oracle` ni
`snapshot`. El evaluador, sin embargo, es local y conserva las labels en el
mismo proceso. Por eso `results.json` declara
`eligibleForPublicProductClaim: false`.

Para una afirmación pública se necesita el holdout externo de
`benchmarks/ga-evaluation/holdout`: tareas y labels descargadas de fuentes
separadas, hashes fijados, candidato aislado, cero labels enviadas al
candidato, atestación independiente y reproducción. Si falta cualquiera de
esas piezas, el resultado es diagnóstico, no certificación.

## Soak y PostgreSQL: no esconder el cuello de botella

El diagnóstico `benchmarks/ga-soak/diagnostic.mjs` mantiene un gate separado
para el coste de checkpoints. La campaña manual del 2026-08-10 obtuvo 587.507
requests, 0 errores y p95/p99 globales de 287,684/420,666 ms, pero PostgreSQL
empleó 2.328.950 ms escribiendo checkpoints y 24 ms sincronizando, un 64,7% de
la hora. Hubo 4 checkpoints temporizados, 0 solicitados, 8.515 buffers y
868.260.959 bytes de WAL; los logs registraron operaciones de escritura de
checkpoint de unos 710–810 segundos.

La conclusión debe separar el pacing normal de un bloqueo real. Con
`requested=0` y sincronización pequeña frente al tiempo de escritura, el
diagnóstico clasifica la ventana como `checkpoint-paced`: conserva el dato para
operaciones, pero no lo convierte en un fallo de disponibilidad. Un checkpoint
solicitado, sincronización dominante, errores de I/O o incumplimiento de SLO se
clasifica como `storage-blocking` y sí mantiene la ejecución no aceptada. El
diagnóstico expone `dominantPhase`, `writeTimePerBufferMs` y
`walBytesPerRequest`, y no permite que `eligibility.eligibleForGa=true` conviva
con `acceptance.passed=false`.

## Checklist antes de publicar un número

1. Confirmar el modo: `offline-temporal-fixture`, `live-github-readonly` o
   `live-postgres-read-only`.
2. Leer `source.class`, `readOnly` y `limitations`.
3. Verificar los SHA-256 de `tasks.json` y `traces.jsonl` con `self-check`.
4. Comprobar denominadores: tareas, freshness eligible, requests y errores.
5. No mezclar fixture, GitHub live, Postgres y holdout en una media única.
6. No llamar “GA” a un resultado local, de una sola ejecución o con un soak
   rechazado por checkpoint.
