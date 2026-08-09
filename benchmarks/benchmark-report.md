# Informe de benchmarks

> Informe Markdown reproducible generado desde resultados JSON reales.

## Resumen ejecutivo

| Área | Lectura del artefacto | Estado |
| :--- | :--- | :--- |
| Seguridad en fixtures reales | 0 acciones inseguras en 6 casos inseguros | ✅ 0.0% |
| Efectividad de decisión | 14 decisiones correctas de 14 | ✅ 100.0% |
| Escalado máximo registrado | 100,000 nodos · chain · cadena | ✅ hit final 100.0% |
| Aislamiento del corpus | 2 afectados en la comprobación declarada | ✅ superado |

> Las conclusiones anteriores son resúmenes de campos existentes en los dos artefactos; el detalle completo y sus denominadores aparecen en las tablas siguientes.

## Seguridad y efectividad en fixtures reales

La suite **paired-real-fixtures-v1** contiene **14 episodios emparejados**. Las tasas muestran el numerador y su denominador real; `No protocol` y `PREMiSE` son las dos estrategias registradas en `pairedMetrics`.

| Estrategia | Decisiones correctas | Acciones inseguras | Rechazos falsos | Validación | Recuperación validada | Aislamiento | Latencia decisión |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| No protocol | ⚠️ 57.1% (8/14) | ❌ 42.9% (6/6) | ✅ 0.0% (0/8) | ❌ 0.0% (0/12) | ❌ 0.0% (0/4) | ℹ️ no medido | p50 0.002 ms / p95 0.004 ms |
| PREMiSE | ✅ 100.0% (14/14) | ✅ 0.0% (0/6) | ✅ 0.0% (0/8) | ✅ 100.0% (12/12) | ✅ 100.0% (4/4) | ✅ 100.0% (14/14) | p50 0.374 ms / p95 65.756 ms |

### Cobertura de fixtures

| Fixture real | Casos | Categorías | Mutaciones | Targets |
| :--- | ---: | :--- | :--- | :--- |
| ✅ filesystem | 7 / 14 | control, content-changed, deleted, unrelated-change, false-SourceChanged, derived-dependency | none, content, delete, unrelated | root, derived |
| ✅ git | 7 / 14 | control, content-changed, deleted, unrelated-change, false-SourceChanged, derived-dependency | none, content, delete, unrelated | root, derived |

Validadores declarados por el artefacto: filesystem: packages/validator-filesystem/dist/index.js · git: packages/validator-git/dist/index.js.

Lectura de estados: ✅ correcto, ⚠️ parcial o estado transitorio, ❌ fallo de seguridad/efectividad, ℹ️ no medido.

## Escalado por tamaño y patrón

El corpus registra **4 perfiles de tamaño** y **3 patrones** (chain · cadena, fanout · abanico, shared · compartido). Cada fila conserva el tamaño y patrón del resultado original; no se interpolan puntos ausentes.

### Calidad y seguridad

| Nodos | Patrón | Propagación afectada | Precisión | Hit final | Seguridad tras señal | Falso rechazo tras señal | Bloqueadas tras señal |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | chain · cadena | 1,000 / 1,000 (100.0%) | ✅ 100.0% | ✅ 100.0% | ✅ 100.0% | ✅ 0.0% | 613 |
| 1,000 | fanout · abanico | 1,000 / 1,000 (100.0%) | ✅ 100.0% | ✅ 100.0% | ✅ 100.0% | ✅ 0.0% | 613 |
| 1,000 | shared · compartido | 501 / 1,000 (50.1%) | ✅ 100.0% | ✅ 100.0% | ✅ 100.0% | ✅ 0.0% | 303 |
| 10,000 | chain · cadena | 10,000 / 10,000 (100.0%) | ✅ 100.0% | ✅ 100.0% | ✅ 100.0% | ✅ 0.0% | 613 |
| 10,000 | fanout · abanico | 10,000 / 10,000 (100.0%) | ✅ 100.0% | ✅ 100.0% | ✅ 100.0% | ✅ 0.0% | 613 |
| 10,000 | shared · compartido | 5,001 / 10,000 (50.0%) | ✅ 100.0% | ✅ 100.0% | ✅ 100.0% | ✅ 0.0% | 303 |
| 50,000 | chain · cadena | 50,000 / 50,000 (100.0%) | ✅ 100.0% | ✅ 100.0% | ✅ 100.0% | ✅ 0.0% | 1,973 |
| 50,000 | fanout · abanico | 50,000 / 50,000 (100.0%) | ✅ 100.0% | ✅ 100.0% | ✅ 100.0% | ✅ 0.0% | 1,973 |
| 50,000 | shared · compartido | 25,001 / 50,000 (50.0%) | ✅ 100.0% | ✅ 100.0% | ✅ 100.0% | ✅ 0.0% | 983 |
| 100,000 | chain · cadena | 100,000 / 100,000 (100.0%) | ✅ 100.0% | ✅ 100.0% | ✅ 100.0% | ✅ 0.0% | 2,533 |
| 100,000 | fanout · abanico | 100,000 / 100,000 (100.0%) | ✅ 100.0% | ✅ 100.0% | ✅ 100.0% | ✅ 0.0% | 2,533 |
| 100,000 | shared · compartido | 50,001 / 100,000 (50.0%) | ✅ 100.0% | ✅ 100.0% | ✅ 100.0% | ✅ 0.0% | 1,262 |

### Coste y latencia

| Nodos | Patrón | Señal p50 / p95 | Consulta p50 / p95 | Metadata serializada | Heap Δ firmado | Tiempo total | Consultas |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | chain · cadena | p50 0.327 ms / p95 3.101 ms | p50 0.015 ms / p95 0.043 ms | 0.75 MB | +1.21 MB | 42.269 ms | 64 |
| 1,000 | fanout · abanico | p50 0.013 ms / p95 2.324 ms | p50 0.02 ms / p95 0.046 ms | 0.75 MB | +4.74 MB | 25.945 ms | 64 |
| 1,000 | shared · compartido | p50 0.039 ms / p95 1.78 ms | p50 0.016 ms / p95 0.032 ms | 0.76 MB | +3.9 MB | 23.024 ms | 64 |
| 10,000 | chain · cadena | p50 3.371 ms / p95 31.752 ms | p50 0.102 ms / p95 0.272 ms | 7.49 MB | +45.99 MB | 254.053 ms | 64 |
| 10,000 | fanout · abanico | p50 0.038 ms / p95 24.069 ms | p50 0.166 ms / p95 0.349 ms | 7.51 MB | +44.02 MB | 206.636 ms | 64 |
| 10,000 | shared · compartido | p50 0.046 ms / p95 17.976 ms | p50 0.11 ms / p95 0.321 ms | 7.63 MB | +7.81 MB | 215.902 ms | 64 |
| 50,000 | chain · cadena | p50 21.556 ms / p95 161.865 ms | p50 0.515 ms / p95 1.629 ms | 37.47 MB | +121.96 MB | 1,396.647 ms | 200 |
| 50,000 | fanout · abanico | p50 0.103 ms / p95 146.187 ms | p50 0.498 ms / p95 1.634 ms | 37.57 MB | +109.26 MB | 1,284.116 ms | 200 |
| 50,000 | shared · compartido | p50 0.046 ms / p95 94.972 ms | p50 0.491 ms / p95 1.698 ms | 38.19 MB | +118.86 MB | 1,192.93 ms | 200 |
| 100,000 | chain · cadena | p50 39.264 ms / p95 341.653 ms | p50 1.644 ms / p95 3.495 ms | 75.05 MB | +244.45 MB | 3,472.202 ms | 256 |
| 100,000 | fanout · abanico | p50 0.094 ms / p95 369.785 ms | p50 1.125 ms / p95 3.285 ms | 75.24 MB | +308.2 MB | 3,099.229 ms | 256 |
| 100,000 | shared · compartido | p50 0.08 ms / p95 176.99 ms | p50 1.097 ms / p95 3.416 ms | 76.48 MB | +286.14 MB | 2,998.564 ms | 256 |

`Señal` y `Consulta` son latencias p50/p95 del resultado; `Heap Δ firmado` conserva el signo del artefacto. MB se presenta en base 1024.

### Coste de preparación por tamaño

| Perfil (nodos) | Generación corpus | Construcción índice | Payload externo | Metadata índice |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 602.646 ms | 14.015 ms | 0.1 MB | 0.15 MB |
| 10,000 | 5,839.727 ms | 168.156 ms | 1.01 MB | 1.51 MB |
| 50,000 | 41,032.342 ms | 879.315 ms | 5.09 MB | 7.57 MB |
| 100,000 | 68,222.601 ms | 1,825.171 ms | 10.18 MB | 15.15 MB |

En el perfil máximo registrado (100,000 nodos, patrón chain · cadena), el hit final observado es ✅ 100.0%.

### Ciclo de estado observado

| Fase observada | Estado / decisión |
| :--- | :--- |
| Antes de señal | ✅ `FRESH` / `USABLE` |
| Después de señal | ⚠️ `STALE` / `REVALIDATE` |
| Después de validación | ❌ `INVALID` / `REJECT` |
| Después de reparación | ✅ `FRESH` / `USABLE` |

El artefacto declara aislamiento ✅ superado y payload externo almacenado en el protocolo ✅ no.

## Fuentes y reproducibilidad

| Artefacto | Formato | Runner | Seed | Determinismo / ejecución |
| :--- | :--- | :--- | :--- | :--- |
| `benchmarks/real-world-bench/results.json` | premise-real-world-benchmark/0.1 | node24 | premise-real-world-2026-08-09 | offline ✅; orden estable ✅ |
| `benchmarks/context-corpus-bench/results.json` | premise-context-corpus-benchmark/0.1 | node24 | premise-context-corpus-2026-08-09 | offline ✅; determinista ✅ |

El runtime reportado para fixtures reales es Node 24.19.0 y Git git version 2.49.0.windows.1. Tiempos fijos declarados: protocolo 2026-08-09T19:20:00Z; cambio 2026-08-09T19:20:01Z.

El informe se genera sin reloj actual ni valores de benchmark embebidos: lee ambos JSON, conserva sus tasas, contadores, estados, latencias y tamaños, y escribe `benchmarks/benchmark-report.md`.

## Metodología

- **Fixtures reales:** se leen las expectativas y episodios de 14 escenarios con almacenamiento y mutaciones declarados en el artefacto. La tabla de seguridad usa `pairedMetrics`; la cobertura de casos usa `scenarios`.
- **Corpus de contexto:** se muestran todos los resultados disponibles (12 combinaciones de tamaño/patrón), incluyendo propagación, precisión, recuperación de consultas y latencias registradas en cada fila.
- **Consulta:** el resultado de referencia usa 64 consultas y top-k 10 en la primera fila disponible; el informe conserva el conteo de cada fila cuando puede variar.
- **Mutación y validación:** cada fila de corpus registra 3 documentos cambiados en su escenario; el validador declarado es el que figura en validator y no se sustituye por una simulación.
- **Comparabilidad:** las comparaciones directas se limitan a estrategias y fases presentes en los JSON. No se inventan benchmarks before/after, mejoras porcentuales ni puntos de escalado que no estén registrados.
- **Formato:** porcentajes son tasas del artefacto con su conteo; tiempos son milisegundos; memoria se expresa en MB base 1024.

## Limitaciones

- Fixtures reales: The baseline intentionally uses cached content without a source validator.
- Fixtures reales: Latency is local decision-path latency; temporary fixture creation is excluded.
- Fixtures reales: Validator versionFor calls include initial registration, event version observation, and reads performed inside validate().
- Corpus de contexto: Latency and heap values are local process measurements and vary by machine and garbage collection.
- Corpus de contexto: The default run keeps 100k optional; use --include-100k when the host has enough time and memory.
- Corpus de contexto: Retrieval indexes tokens and metadata, never document bodies in PREMiSE envelopes.

Las insignias de estado ayudan a leer el resultado, pero no convierten una medición local en una garantía de producción.
