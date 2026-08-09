# Informe de benchmarks

> Informe Markdown reproducible generado desde resultados JSON reales.

## Resumen ejecutivo

| Área | Lectura del artefacto | Estado |
| :--- | :--- | :--- |
| Gate de seguridad emparejado | 24 episodios · 0.0% uso inseguro PREMiSE | ✅ superado |
| Seguridad en fixtures reales | 0 acciones inseguras en 6 casos inseguros | ✅ 0.0% |
| Efectividad de decisión | 14 decisiones correctas de 14 | ✅ 100.0% |
| Escalado máximo registrado | 100,000 nodos · chain · cadena | ✅ hit final 100.0% |
| Aislamiento del corpus | 2 afectados en la comprobación declarada | ✅ superado |
| Propagación de contexto largo | 25,000 nodos · chain · cadena · 25,000 afectados | ✅ `FRESH` |

> Las conclusiones anteriores son resúmenes de campos existentes en los cuatro artefactos; el detalle completo y sus denominadores aparecen en las tablas siguientes.

## Comparativa emparejada: baseline frente a PREMiSE

La suite **paired-validity-v0.2** compara 24 episodios con el mismo oráculo. Los denominadores aparecen por métrica para evitar que una tasa de seguridad se confunda con una tasa de recuperación.

| Estrategia | Episodios | Uso inseguro | Recuperación | Rechazo no reparable | Revalidaciones | Lecturas/episodio | Latencia | Memoria | Historial |
| :--- | ---: | :--- | :--- | :--- | ---: | ---: | :--- | :--- | :--- |
| No protocol | 24 | 100.0% (n=21) | 0.0% (n=12) | 0.0% (n=9) | 0 | 1 | p50 0 ms / p95 0.001 ms | p50 31 B / p95 32 B | 0.0% |
| PREMiSE | 24 | 0.0% (n=21) | 100.0% (n=12) | 100.0% (n=9) | 21 | 1.88 | p50 0.042 ms / p95 0.346 ms | p50 1,151 B / p95 1,421 B | 100.0% |

Interpretación: primero se aplica el gate de seguridad (uso inseguro = 0%); después se comparan recuperación, relecturas, latencia, memoria e historial. El baseline es más barato porque no revalida: esa cifra no constituye una mejora si permite usar memoria obsoleta.

## Seguridad y efectividad en fixtures reales

La suite **paired-real-fixtures-v1** contiene **14 episodios emparejados**. Las tasas muestran el numerador y su denominador real; `No protocol` y `PREMiSE` son las dos estrategias registradas en `pairedMetrics`.

| Estrategia | Decisiones correctas | Acciones inseguras | Rechazos falsos | Validación | Recuperación validada | Aislamiento | Latencia decisión |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| No protocol | ⚠️ 57.1% (8/14) | ❌ 42.9% (6/14) | ✅ 0.0% (0/8) | ℹ️ no medido | ℹ️ no medido | ℹ️ no medido | p50 0.001 ms / p95 0.004 ms |
| PREMiSE | ✅ 100.0% (14/14) | ✅ 0.0% (0/14) | ✅ 0.0% (0/8) | ✅ 100.0% (12/12) | ✅ 100.0% (4/4) | ✅ 100.0% (14/14) | p50 0.365 ms / p95 65.028 ms |

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

| Nodos | Patrón | Propagación afectada | Precisión final | Hit tras señal | Hit tras reparación | Seguridad tras señal (candidatos) | Falso rechazo candidatos | Falso rechazo controles | Seguridad tras reparación | Bloqueadas tras señal |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | chain · cadena | 1,000 / 1,000 (100.0%) | ✅ 100.0% | ⚠️ 11.1% | ✅ 100.0% | ✅ 100.0% (613/613) | ✅ 0.0% (0/8) | ✅ 0.0% (0/8) | ✅ 100.0% (1,000/1,000) | 613 |
| 1,000 | fanout · abanico | 1,000 / 1,000 (100.0%) | ✅ 100.0% | ⚠️ 11.1% | ✅ 100.0% | ✅ 100.0% (613/613) | ✅ 0.0% (0/8) | ✅ 0.0% (0/8) | ✅ 100.0% (1,000/1,000) | 613 |
| 1,000 | shared · compartido | 501 / 1,000 (50.1%) | ✅ 100.0% | ⚠️ 56.9% | ✅ 100.0% | ✅ 100.0% (303/303) | ✅ 0.0% (0/318) | ✅ 0.0% (0/8) | ✅ 100.0% (501/501) | 303 |
| 10,000 | chain · cadena | 10,000 / 10,000 (100.0%) | ✅ 100.0% | ⚠️ 11.1% | ✅ 100.0% | ✅ 100.0% (613/613) | ✅ 0.0% (0/8) | ✅ 0.0% (0/8) | ✅ 100.0% (10,000/10,000) | 613 |
| 10,000 | fanout · abanico | 10,000 / 10,000 (100.0%) | ✅ 100.0% | ⚠️ 11.1% | ✅ 100.0% | ✅ 100.0% (613/613) | ✅ 0.0% (0/8) | ✅ 0.0% (0/8) | ✅ 100.0% (10,000/10,000) | 613 |
| 10,000 | shared · compartido | 5,001 / 10,000 (50.0%) | ✅ 100.0% | ⚠️ 58.3% | ✅ 100.0% | ✅ 100.0% (303/303) | ✅ 0.0% (0/318) | ✅ 0.0% (0/8) | ✅ 100.0% (5,001/5,001) | 303 |
| 50,000 | chain · cadena | 50,000 / 50,000 (100.0%) | ✅ 100.0% | ⚠️ 3.8% | ✅ 100.0% | ✅ 100.0% (1,973/1,973) | ✅ 0.0% (0/8) | ✅ 0.0% (0/8) | ✅ 100.0% (50,000/50,000) | 1,973 |
| 50,000 | fanout · abanico | 50,000 / 50,000 (100.0%) | ✅ 100.0% | ⚠️ 3.8% | ✅ 100.0% | ✅ 100.0% (1,973/1,973) | ✅ 0.0% (0/8) | ✅ 0.0% (0/8) | ✅ 100.0% (50,000/50,000) | 1,973 |
| 50,000 | shared · compartido | 25,001 / 50,000 (50.0%) | ✅ 100.0% | ⚠️ 53.4% | ✅ 100.0% | ✅ 100.0% (983/983) | ✅ 0.0% (0/998) | ✅ 0.0% (0/8) | ✅ 100.0% (25,001/25,001) | 983 |
| 100,000 | chain · cadena | 100,000 / 100,000 (100.0%) | ✅ 100.0% | ⚠️ 3.0% | ✅ 100.0% | ✅ 100.0% (2,533/2,533) | ✅ 0.0% (0/8) | ✅ 0.0% (0/8) | ✅ 100.0% (100,000/100,000) | 2,533 |
| 100,000 | fanout · abanico | 100,000 / 100,000 (100.0%) | ✅ 100.0% | ⚠️ 3.0% | ✅ 100.0% | ✅ 100.0% (2,533/2,533) | ✅ 0.0% (0/8) | ✅ 0.0% (0/8) | ✅ 100.0% (100,000/100,000) | 2,533 |
| 100,000 | shared · compartido | 50,001 / 100,000 (50.0%) | ✅ 100.0% | ⚠️ 53.8% | ✅ 100.0% | ✅ 100.0% (1,262/1,262) | ✅ 0.0% (0/1,279) | ✅ 0.0% (0/8) | ✅ 100.0% (50,001/50,001) | 1,262 |

### Coste y latencia

| Nodos | Patrón | Señal p50 / p95 | Consulta p50 / p95 | Metadata serializada | Heap Δ firmado | Tiempo total | Consultas |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | chain · cadena | p50 0.202 ms / p95 3.097 ms | p50 0.014 ms / p95 0.041 ms | 0.75 MB | −0.93 MB | 46.036 ms | 72 |
| 1,000 | fanout · abanico | p50 0.018 ms / p95 2.328 ms | p50 0.014 ms / p95 0.03 ms | 0.75 MB | +10.49 MB | 27.089 ms | 72 |
| 1,000 | shared · compartido | p50 0.012 ms / p95 1.447 ms | p50 0.012 ms / p95 0.024 ms | 0.76 MB | +5.19 MB | 27.559 ms | 72 |
| 10,000 | chain · cadena | p50 2.314 ms / p95 28.362 ms | p50 0.099 ms / p95 0.318 ms | 7.49 MB | +47.96 MB | 288.707 ms | 72 |
| 10,000 | fanout · abanico | p50 0.052 ms / p95 25.362 ms | p50 0.096 ms / p95 0.339 ms | 7.51 MB | +45.85 MB | 207.387 ms | 72 |
| 10,000 | shared · compartido | p50 0.019 ms / p95 13.613 ms | p50 0.156 ms / p95 0.328 ms | 7.63 MB | +18.57 MB | 200.202 ms | 72 |
| 50,000 | chain · cadena | p50 8.574 ms / p95 192.249 ms | p50 0.499 ms / p95 1.11 ms | 37.47 MB | +130.1 MB | 1,468.486 ms | 208 |
| 50,000 | fanout · abanico | p50 0.084 ms / p95 156.762 ms | p50 0.828 ms / p95 1.742 ms | 37.57 MB | +84.59 MB | 1,430.046 ms | 208 |
| 50,000 | shared · compartido | p50 0.071 ms / p95 78.407 ms | p50 0.839 ms / p95 1.716 ms | 38.19 MB | +130.48 MB | 1,280.749 ms | 208 |
| 100,000 | chain · cadena | p50 21.193 ms / p95 374.853 ms | p50 1.065 ms / p95 2.899 ms | 75.05 MB | +250.23 MB | 3,379.512 ms | 264 |
| 100,000 | fanout · abanico | p50 0.079 ms / p95 344.614 ms | p50 1.068 ms / p95 3.369 ms | 75.24 MB | +292.96 MB | 3,175.33 ms | 264 |
| 100,000 | shared · compartido | p50 0.045 ms / p95 166.579 ms | p50 1.055 ms / p95 2.381 ms | 76.48 MB | +297.2 MB | 2,755.822 ms | 264 |

`Tras señal` muestra la ventana en la que el protocolo bloquea memorias potencialmente obsoletas; `tras reparación` comprueba todos los nodos afectados, no solo el target. La seguridad y los falsos rechazos de candidatos usan denominadores de candidatos; los controles usan denominadores de consultas y se muestran por separado. Las latencias son p50/p95; `Heap Δ firmado` conserva el signo del artefacto. MB se presenta en base 1024.

### Coste de preparación por tamaño

| Perfil (nodos) | Generación corpus | Construcción índice | Payload externo | Metadata índice |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1,219.559 ms | 14.338 ms | 0.1 MB | 0.15 MB |
| 10,000 | 12,645.503 ms | 177.209 ms | 1.01 MB | 1.51 MB |
| 50,000 | 70,500.939 ms | 890.556 ms | 5.09 MB | 7.57 MB |
| 100,000 | 124,096.604 ms | 1,813.666 ms | 10.18 MB | 15.15 MB |

En el perfil máximo registrado (100,000 nodos, patrón chain · cadena), el hit final observado es ✅ 100.0%.

### Ciclo de estado observado

| Fase observada | Estado / decisión |
| :--- | :--- |
| Antes de señal | ✅ `FRESH` / `USABLE` |
| Después de señal | ⚠️ `STALE` / `REVALIDATE` |
| Después de validación | ❌ `INVALID` / `REJECT` |
| Después de reparación | ✅ `FRESH` / `USABLE` |

El artefacto declara aislamiento ✅ superado y payload externo almacenado en el protocolo ✅ no.

## Contexto largo y propagación selectiva

El benchmark de grafo contiene **4 perfiles de tamaño** y **3 topologías** (chain · cadena, fanout · abanico, shared · compartido). Mide el ciclo completo: construir metadatos, detectar cambio, propagar obsolescencia y reparar la raíz validada.

### Correctitud de propagación

| Nodos | Topología | Afectados | Ciclo de estado |
| ---: | :--- | ---: | :--- |
| 1,000 | chain · cadena | 1,000 / 1,000 (100.0%) | ✅ `FRESH` → ⚠️ `STALE` → ✅ `FRESH` |
| 1,000 | fanout · abanico | 1,000 / 1,000 (100.0%) | ✅ `FRESH` → ⚠️ `STALE` → ✅ `FRESH` |
| 1,000 | shared · compartido | 500 / 1,000 (50.0%) | ✅ `FRESH` → ⚠️ `STALE` → ✅ `FRESH` |
| 5,000 | chain · cadena | 5,000 / 5,000 (100.0%) | ✅ `FRESH` → ⚠️ `STALE` → ✅ `FRESH` |
| 5,000 | fanout · abanico | 5,000 / 5,000 (100.0%) | ✅ `FRESH` → ⚠️ `STALE` → ✅ `FRESH` |
| 5,000 | shared · compartido | 2,500 / 5,000 (50.0%) | ✅ `FRESH` → ⚠️ `STALE` → ✅ `FRESH` |
| 10,000 | chain · cadena | 10,000 / 10,000 (100.0%) | ✅ `FRESH` → ⚠️ `STALE` → ✅ `FRESH` |
| 10,000 | fanout · abanico | 10,000 / 10,000 (100.0%) | ✅ `FRESH` → ⚠️ `STALE` → ✅ `FRESH` |
| 10,000 | shared · compartido | 5,000 / 10,000 (50.0%) | ✅ `FRESH` → ⚠️ `STALE` → ✅ `FRESH` |
| 25,000 | chain · cadena | 25,000 / 25,000 (100.0%) | ✅ `FRESH` → ⚠️ `STALE` → ✅ `FRESH` |
| 25,000 | fanout · abanico | 25,000 / 25,000 (100.0%) | ✅ `FRESH` → ⚠️ `STALE` → ✅ `FRESH` |
| 25,000 | shared · compartido | 12,500 / 25,000 (50.0%) | ✅ `FRESH` → ⚠️ `STALE` → ✅ `FRESH` |

### Coste de señal y reparación

| Nodos | Topología | Señal | Validación | Tiempo total | Heap Δ | Payload externo |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: |
| 1,000 | chain · cadena | 3.399 ms | 3.37 ms | 16.228 ms | 4.95 MB | 0.06 MB |
| 1,000 | fanout · abanico | 2.141 ms | 2.43 ms | 11.138 ms | 7.75 MB | 0.06 MB |
| 1,000 | shared · compartido | 1.78 ms | 1.076 ms | 8.178 ms | 0 MB | 0.06 MB |
| 5,000 | chain · cadena | 15.149 ms | 11.693 ms | 53.836 ms | 7.21 MB | 0.06 MB |
| 5,000 | fanout · abanico | 9.822 ms | 10.778 ms | 47.48 ms | 27.3 MB | 0.06 MB |
| 5,000 | shared · compartido | 7.878 ms | 5.447 ms | 33.167 ms | 18.37 MB | 0.06 MB |
| 10,000 | chain · cadena | 27.715 ms | 32.594 ms | 102.688 ms | 0 MB | 0.06 MB |
| 10,000 | fanout · abanico | 25.088 ms | 22.308 ms | 87.078 ms | 50.46 MB | 0.06 MB |
| 10,000 | shared · compartido | 14.959 ms | 10.266 ms | 71.308 ms | 0 MB | 0.06 MB |
| 25,000 | chain · cadena | 57.204 ms | 58.078 ms | 228.414 ms | 73.44 MB | 0.06 MB |
| 25,000 | fanout · abanico | 68.396 ms | 55.95 ms | 241.3 ms | 0 MB | 0.06 MB |
| 25,000 | shared · compartido | 27.938 ms | 29.671 ms | 171.547 ms | 22.87 MB | 0.06 MB |

En el perfil máximo (25,000 nodos, chain · cadena), la señal afecta 25,000 nodos y la reparación termina en ✅ `FRESH`. Aislamiento: ✅ superado.

Las topologías chain/fanout deben propagar el cambio por toda la rama; shared debe afectar solo la rama que comparte la fuente señalada.

## Fuentes y reproducibilidad

| Artefacto | Formato | Runner | Seed | Determinismo / ejecución |
| :--- | :--- | :--- | :--- | :--- |
| `benchmarks/comparative-bench/results.json` | premise-comparative-benchmark/0.1 | node24 | premise-comparative-2026-08-09 | episodios emparejados ✅ |
| `benchmarks/real-world-bench/results.json` | premise-real-world-benchmark/0.1 | node24 | premise-real-world-2026-08-09 | offline ✅; orden estable ✅ |
| `benchmarks/context-corpus-bench/results.json` | premise-context-corpus-benchmark/0.1 | node24 | premise-context-corpus-2026-08-09 | offline ✅; determinista ✅ |
| `benchmarks/long-context-bench/results.json` | premise-long-context-benchmark/0.1 | node24 | 4 perfiles | payload externo ✅; aislamiento ✅ |

El runtime reportado para fixtures reales es Node 24.19.0 y Git git version 2.49.0.windows.1. Tiempos fijos declarados: protocolo 2026-08-09T19:20:00Z; cambio 2026-08-09T19:20:01Z.

El informe se genera sin reloj actual ni valores de benchmark embebidos: lee los cuatro JSON, conserva sus tasas, contadores, estados, latencias y tamaños, y escribe `benchmarks/benchmark-report.md`.

## Metodología

- **Fixtures reales:** se leen las expectativas y episodios de 14 escenarios con almacenamiento y mutaciones declarados en el artefacto. La tabla de seguridad usa `pairedMetrics`; la cobertura de casos usa `scenarios`.
- **Comparativa emparejada:** se muestran las 24 situaciones compartidas por `No protocol` y `PREMiSE`; uso inseguro, recuperación y rechazo no reparable conservan sus denominadores propios.
- **Corpus de contexto:** se muestran todos los resultados disponibles (12 combinaciones de tamaño/patrón), incluyendo propagación, precisión, recuperación de consultas y latencias registradas en cada fila.
- **Consulta:** el resultado de referencia usa 72 consultas y top-k 10 en la primera fila disponible; el informe conserva el conteo de cada fila cuando puede variar.
- **Mutación y validación:** cada fila de corpus registra 3 documentos cambiados en su escenario; el validador declarado es el que figura en validator y no se sustituye por una simulación.
- **Contexto largo:** se conservan las 12 combinaciones de tamaño/topología del artefacto, con estado antes de señal, después de señal y después de reparación, además de latencias y memoria.
- **Comparabilidad:** las comparaciones directas se limitan a estrategias y fases presentes en los JSON. No se inventan benchmarks before/after, mejoras porcentuales ni puntos de escalado que no estén registrados.
- **Formato:** porcentajes son tasas del artefacto con su conteo; tiempos son milisegundos; memoria se expresa en MB base 1024.

## Limitaciones

- Comparativa emparejada: The baseline intentionally represents use-without-revalidation, not a full memory product.
- Comparativa emparejada: Memory bytes are serialized metadata bytes, not process-wide heap attribution.
- Comparativa emparejada: Latency is local deterministic runtime latency and is not a production SLA.
- Fixtures reales: The baseline intentionally uses cached content without a source validator.
- Fixtures reales: Latency is local decision-path latency; temporary fixture creation is excluded.
- Fixtures reales: Validator versionFor calls include initial registration, event version observation, and reads performed inside validate().
- Corpus de contexto: Latency and heap values are local process measurements and vary by machine and garbage collection.
- Corpus de contexto: The default run keeps 100k optional; use --include-100k when the host has enough time and memory.
- Corpus de contexto: Retrieval indexes tokens and metadata, never document bodies in PREMiSE envelopes.
- Contexto largo: heapDeltaBytes is process-level sampled heap, not an isolated allocation profile.
- Contexto largo: externalPayloadBytes describes content held outside PREMiSE; the runner deliberately does not store that content in envelopes.
- Contexto largo: Profiles are local Node 24 measurements and should be repeated on the target deployment hardware.

Las insignias de estado ayudan a leer el resultado, pero no convierten una medición local en una garantía de producción.
