# GA Evaluation: benchmark externo y ciego

## Propósito

`benchmarks/ga-evaluation` es una campaña de evaluación externa del contrato de
vigencia: compara cuatro comportamientos sobre las mismas tareas y fuentes
públicas:

| Estrategia | Comportamiento |
| --- | --- |
| `direct-read` | Lee la fuente en cada tarea. |
| `ttl-cache` | Reutiliza una lectura durante tres turnos, sin comprobar versión. |
| `retrieval-no-protocol` | Calienta un índice una vez y lo usa sin provenance ni revalidación. |
| `PREMiSE` | Conserva provenance/version, hace una sonda de versión y vuelve a leer cuando cambia. |

El nombre `PREMiSE` identifica aquí el comportamiento de referencia
version-gated, expresado según el contrato del protocolo. No es una afirmación
de rendimiento de todas las implementaciones PREMiSE.

La suite no mide inteligencia general ni calidad de un LLM: cada tarea tiene un
parser determinista en el oracle del evaluador. El sistema real puede ser un
agente o un servicio externo y debe resolver la tarea mediante el protocolo
ciego.

## Ejecutar

Desde la raíz del repositorio:

```powershell
node benchmarks/ga-evaluation/runner.mjs --split all
node benchmarks/ga-evaluation/self-check.mjs
```

Opciones:

```text
--split all|visible|hidden|holdout   (por defecto: all)
--repetitions N                     (por defecto: 1)
--candidate "comando"               añade un candidato real por NDJSON
--task-timeout-ms N                 timeout por tarea del candidato
```

La campaña no tiene modo offline que sustituya evidencia pública por fixtures.
El verificador descarga todas las entradas de `datasets/v1.json`, recalcula
SHA-256, materializa los archivos filesystem y clona el repositorio necesario
para el adapter Git. Un fallo de red, commit inexistente, contenido distinto o
hash incorrecto es un fallo de campaña, no un resultado `UNKNOWN` utilizable.

## Versionado y splits

- `manifest/v1.json` es el manifiesto versionado de tareas. Contiene prompt,
  fuente, snapshot para el evaluador y oracle; el snapshot y oracle nunca salen
  por el protocolo de candidato.
- `datasets/v1.json` fija URLs públicas, commits, paths, media types y SHA-256.
  Las URLs son descargas inmutables por commit en `raw.githubusercontent.com`.
- `visible` sirve para desarrollo y smoke tests.
- `hidden` contiene prompts no usados para ajustar la estrategia.
- `holdout` es el split para la afirmación final; no se debe tunear contra él.

Las tareas usan dos snapshots públicos de Requests para representar una
transición reproducible de versión, además de fuentes estáticas públicas. Eso
permite medir stale reads sin afirmar que el benchmark mutó un repositorio
real durante la ejecución.

## Protocolo ciego para tareas reales

Un candidato se ejecuta como proceso separado con su `cwd` apuntando a un
directorio runtime sin manifiestos ni answer key. El runner escribe una línea
por tarea:

```json
{
  "type": "task",
  "task": {
    "protocol": "ga-evaluation/1",
    "taskId": "opaque-…",
    "prompt": "…",
    "source": {"id": "github.requests.version", "uri": "github://…", "adapter": "github"},
    "capabilities": ["read", "version"]
  }
}
```

El candidato puede solicitar evidencia, sin que el runner le entregue el
oracle:

```json
{"type":"read","requestId":"1","sourceId":"github.requests.version"}
{"type":"version","requestId":"2","sourceId":"github.requests.version"}
```

El runner responde con contenido público verificado solo para `read`, o con
version/provenance para `version`. Una respuesta final tiene esta forma:

```json
{"type":"answer","answer":"2.34.2","decision":"USE","status":"FRESH"}
```

No se envían `split`, `snapshot`, `oracle`, `expected`, `gold`, correctness,
trazas ni métricas al candidato. El contenido de una fuente puede contener la
respuesta porque es la evidencia real que el usuario pidió; lo que nunca se
filtra es la respuesta esperada calculada por el evaluador. Para candidatos no
confiables, el aislamiento del proceso debe reforzarse con el sandbox de la
infraestructura que lo ejecuta: este protocolo evita filtraciones lógicas, no
es una frontera de seguridad del sistema operativo.

Una petición fuera de la fuente activa, un mensaje no JSON, una decisión
desconocida o un timeout se registra como indisponibilidad del candidato. El
runner ignora cualquier `provenance` que el candidato intente inventar y solo
cuenta evidencia emitida por el broker verificado.

## Adapters y evidencia

Los tres adapters comparten la misma interfaz lógica:

- `github`: descarga el raw URL HTTPS en cada `read`/`version` y comprueba
  SHA-256.
- `filesystem`: lee el archivo materializado desde una descarga pública y
  recalcula SHA-256 en cada operación.
- `git`: usa `git show <commit>:<path>`, verifica que el commit existe y que el
  blob coincide con el SHA-256 de la descarga raw independiente.

La evidencia que entra en una traza debe tener `kind: external`,
`origin: public-download`, URL HTTPS allowlisted y SHA-256 de 64 hex. Se
rechazan `fixture://`, `data:`, `file:` como descargas externas, contenido
local presentado como público y cualquier fallback sin hash. `file://` puede
aparecer solo como URI lógica de un dataset filesystem materializado; el
origen probatorio sigue siendo la descarga HTTPS fijada y verificada.

## Métricas

Cada métrica se emite en JSON y en el reporte Markdown, tanto agregada como por
split cuando hay tareas seleccionadas:

- `correctRate`: respuestas exactas sobre todas las tareas.
- `freshnessRate`: respuestas disponibles cuya versión usada coincide con la
  versión del snapshot de la tarea.
- `falsePositiveRate`: respuestas `USE` disponibles que son incorrectas; una
  lectura stale presentada como utilizable cuenta como falso positivo.
- `availabilityRate`: tareas con una respuesta `USE` sin error.
- `latencyMs.p50/p95/p99`: percentiles nearest-rank sobre la latencia de cada
  tarea, incluidos errores.
- `requests`: operaciones de fuente del broker; `readRequests` y
  `versionRequests` se separan y `adapterRequests` desglosa GitHub/filesystem/Git.
- `costUsd`: estimación explícita del coste de operaciones de fuente más un
  pequeño proxy de CPU local. No es una factura: excluye tokens, proveedor,
  ancho de banda y revisión humana.

Las peticiones de verificación inicial de datasets se reportan aparte y no se
atribuyen a una estrategia. El warm-up del baseline de retrieval sí forma parte
de sus `requests` y se identifica como `warmupRequests`.

## Artefactos y self-checks

Una campaña exitosa escribe únicamente dentro de
`benchmarks/ga-evaluation/outputs`:

- `results.json`: formato `ga-evaluation-result/1`.
- `report.md`: tablas, verificación y límites de claims.
- `traces.jsonl`: una línea por estrategia/tarea con decisiones, hashes de
  versión, latencia, peticiones y digests; no incluye el texto de respuestas ni
  el oracle.

`self-check.mjs` valida la estructura versionada, los tres splits, p99, rechazo
de fixtures, ausencia de campos dorados en tareas públicas y trazas, y que una
salida presente tenga las cuatro métricas comparables y el PREMiSE de referencia
sin falsos positivos. Puede ejecutarse sin red para validar el harness; una
campaña real siempre necesita pasar la verificación pública del runner.

## Claims permitidos

Con una ejecución concreta solo se pueden afirmar los números observados para:

1. el `manifest/v1.json` y `datasets/v1.json` exactos;
2. los SHA-256 verificados en esa ejecución;
3. la versión del runner, Node, plataforma y configuración reportadas;
4. el conjunto de tareas y split ejecutado;
5. los traces conservados junto a `results.json` y `report.md`.

Una afirmación pública más fuerte necesita, como mínimo, varias semillas o
repeticiones, el holdout no usado para ajustar, intervalos de confianza,
trazas completas, dos infraestructuras y reproducción independiente con los
mismos hashes.

## Claims prohibidos

Este benchmark no autoriza afirmar que:

- PREMiSE descubre una verdad universal o valida la corrección semántica de un
  documento;
- un resultado exacto aquí mide calidad general de un modelo, retrieval
  semántico, embeddings o ranking;
- una latencia local es un SLA de producción;
- el coste estimado es una factura de GitHub, nube o proveedor de modelos;
- el baseline o PREMiSE causa un uplift de producto fuera de estas tareas;
- una transición entre snapshots públicos equivale a recuperar una mutación
  en vivo;
- un `UNKNOWN`, fallo de hash o fuente no verificable puede convertirse en
  evidencia externa por conveniencia.
