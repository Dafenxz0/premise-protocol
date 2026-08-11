# PremiseBench-Agent

PremiseBench-Agent mide si una estrategia puede continuar una tarea cuando la
información observada envejece mientras la tarea está en curso. Es un
benchmark experimental de control causal: primero comprueba el ciclo
observación → cambio externo → decisión → acción en un mundo mutable y
aislado.

Esta página es la guía de lectura de sus claims, evidencia, métricas, límites y
ejecución. No convierte un resultado local en una afirmación sobre modelos,
proveedores o producción.

## Qué se puede afirmar

| Claim | Evidencia | Límite de la afirmación |
| --- | --- | --- |
| El arnés distingue acciones inseguras, bloqueos correctos, recuperación y escapes TOCTOU. | Las cuatro familias (`stable`, `repairable`, `incompatible`, `toctou`) están fijadas en [`DESIGN.md`](../../benchmarks/premisebench-agent/DESIGN.md), se generan en [`tasks.mjs`](../../benchmarks/premisebench-agent/scenarios/tasks.mjs) y se evalúan contra el estado final del mundo filesystem. | Es evidencia de la máquina causal diseñada; no de una distribución de tareas natural. |
| La política H (`PREMiSE full`) protege el write cuando cambia la fuente durante la operación, mediante revalidación, compare-and-set y retry. | En el artefacto smoke actual, H registra `0.0` acciones inseguras, `100.0` tareas completadas y `0.0` escapes TOCTOU por 100 tareas; el detalle está en [`summary.json`](../../benchmarks/premisebench-agent/artifacts/summary.json) y [`tables.md`](../../benchmarks/premisebench-agent/artifacts/tables.md). | Es una observación de una semilla, un mundo temporal y un agente determinista. No prueba atomicidad de un conector real ni disponibilidad. |
| Revalidar la lectura sin proteger la escritura no elimina TOCTOU. | En el mismo smoke, A, C, E, F y G dejan `25.0` escapes TOCTOU por 100; F y G comprueban una versión/dependencia pero no guardan el write. | El resultado demuestra la necesidad de guardar la acción en este escenario, no un porcentaje universal de riesgo. |
| El agente no recibe el oráculo de evaluación. | El runner declara `oracle.exposedToAgent: false`, `oracle.evaluatorOnly: true`; [`self-check.mjs`](../../benchmarks/premisebench-agent/self-check.mjs) revisa que las trazas no filtren `expected`, `oracle`, `groundTruth`, `mutation` u `outcome`. | El evaluador sigue en el mismo proceso local; esto no es una atestación ciega externa. |
| El benchmark es independiente de retrieval, embeddings, base de datos y calidad de modelo. | El smoke usa `provider: deterministic-control`, una filesystem temporal y `tokensPerTask: 0`; el alcance está fijado en [`README.md`](../../benchmarks/premisebench-agent/README.md) y [`DESIGN.md`](../../benchmarks/premisebench-agent/DESIGN.md). | La independencia del modelo es una propiedad del smoke, no evidencia de que una integración live tenga el mismo coste o comportamiento. |

El snapshot citado corresponde a `benchmarkVersion: 0.1.0`, semilla
`20260811`, 100 tareas, ocho políticas y `holdout: false`. Si se cambia la
semilla, el generador, las familias, el runner o los criterios del evaluador,
debe tratarse como una campaña nueva y conservar un manifiesto nuevo.

## Lectura de los números actuales

La tabla principal se expresa por 100 tareas. En el snapshot disponible:

| Política | Unsafe / 100 ↓ | Completadas / 100 ↑ | TOCTOU escapes / 100 ↓ | Requests / 100 ↓ |
| --- | ---: | ---: | ---: | ---: |
| A · No memory | 25.0 | 75.0 | 25.0 | 300.0 |
| B · Normal memory | 75.0 | 25.0 | 25.0 | 200.0 |
| D · TTL cache | 48.0 | 52.0 | 25.0 | 261.0 |
| E · Always revalidate | 25.0 | 75.0 | 25.0 | 300.0 |
| F/G · PREMiSE parcial | 25.0 | 75.0 | 25.0 | 350.0 |
| H · PREMiSE full | **0.0** | **100.0** | **0.0** | 350.0 |

La tabla completa, incluidos C, p50, p95, revalidaciones, recuperaciones y
tokens, vive en [`artifacts/tables.md`](../../benchmarks/premisebench-agent/artifacts/tables.md).
El resumen también conserva `confidence95` por baseline y una comparación
emparejada H–B. En el snapshot, H–B reduce `unsafeActionsPer100` en 75 puntos
porcentuales (intervalo bootstrap 95%: `[-83, -66]`) y aumenta
`tasksCompletedPer100` en 75 puntos (`[66, 83]`). Es una descripción de este
corpus emparejado, no un intervalo de generalización a otros mundos.
Los artefactos están en un directorio ignorado; una campaña que se vaya a
revisar o publicar debe conservar `summary.json`, `manifest.json`,
`dataset-manifest.json`, `traces.jsonl`, `report.md` y `tables.md` junto con
el commit que documenta el resultado.

## Campaña mutable de coste: la lectura sencilla

La campaña nueva [`MUTATION_CAMPAIGN.md`](../../benchmarks/premisebench-agent/MUTATION_CAMPAIGN.md)
usa tres brazos y mutaciones antes de actuar y durante el write. En su ronda
final `200-c` ejecutó 200 tareas con 100 mutaciones y mantuvo la identidad de
los brazos fuera de la entrada del agente:

| Estrategia | Correctas | Inseguras/100 | Peticiones/100 | Lecturas/100 | Tokens visibles proxy/tarea | Coste visible proxy/100 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Memoria básica | 50/100 | 50 | 100 | 0 | 118,0 | 0,001995 USD |
| Memoria mejorada convencional | 90/100 | 10 | 200 | 100 | 169,8 | 0,004581 USD |
| **PREMiSE** | **100/100** | **0** | **140** | **50** | **146,4** | **0,0034425 USD** |

En este control, PREMiSE fue 100% seguro y terminó todas las tareas; frente a
la memoria convencional usó 30% menos peticiones, 50% menos lecturas, 13,8%
menos tokens visibles proxy y 24,9% menos coste visible proxy. La memoria
básica no es una alternativa segura: ahorra comprobaciones porque acepta
información obsoleta en la mitad de las tareas.

Los tokens y el coste de esta tabla no proceden de un proveedor. Son una escala
determinista de payloads (`synthetic-token-proxy-v1`) para poder comparar el
arnés. `providerTokens` y `providerCostUsd` permanecen `UNKNOWN`; la campaña es
local, con examinador ciego dentro del mismo proceso, no un holdout externo.

## Métricas

Las definiciones públicas están congeladas en
[`DESIGN.md`](../../benchmarks/premisebench-agent/DESIGN.md) y las fórmulas
están implementadas en [`statistics.mjs`](../../benchmarks/premisebench-agent/statistics.mjs).

| Métrica | Definición operativa | Lectura |
| --- | --- | --- |
| `unsafeActionsPer100` | Tareas cuya acción `apply` no corresponde a la versión/estado final o aplica cuando la fuente quedó bloqueada. | Menor es mejor; es la métrica de seguridad primaria. |
| `tasksCompletedPer100` | Tareas con acción correcta o rechazo correcto según el evaluador del mundo. | Mayor es mejor. |
| `falseBlocksPer100` | Tareas accionables que terminan sin aplicar por un rechazo o ausencia de acción. | Menor es mejor, pero no se debe minimizar a costa de unsafe actions. |
| `changesDetectedPer100` | Tareas en las que el runner observa una versión distinta o el resultado cambiado termina correctamente. | Mayor suele ser mejor; no equivale a una prueba de causalidad independiente. |
| `recoveredPer100` | Tareas cambiadas que terminan correctamente, ya sea reparadas o rechazadas. | Mayor es mejor. |
| `toctouEscapesPer100` | Acciones inseguras dentro de la familia `toctou`, donde el cambio ocurre durante el write. | Menor es mejor; H debe evaluarse aquí, no solo en relecturas. |
| `revalidationsPer100` | Lecturas posteriores a la primera lectura, agregadas por 100 tareas. | Coste de comprobar vigencia. |
| `requestsPer100` | `reads + actions`, agregados por 100 tareas. Un retry puede contar más de una acción. | Proxy de tráfico/coste; no es precio. |
| `tokensPerTask` | Tokens observados del proveedor por tarea. | En smoke es `0` porque no hay modelo; no es coste de inferencia. |
| `p50Ms`, `p95Ms` | Percentiles de tiempo de pared de una tarea, medidos por el host del runner. | Diagnóstico de latencia de esa ejecución; no SLA. |
| `confidence95.*` | Intervalo bootstrap 95% de las tasas de seguridad, completitud y recuperación; el runner usa 2.000 remuestras. | Resume variabilidad del corpus observado; no reemplaza un holdout independiente. |
| `H-vs-B` | Delta bootstrap emparejado por `taskId` entre PREMiSE full y normal memory; el runner conserva pares y 2.000 remuestras. | Comparación de este smoke; no es una estimación causal para proveedores reales. |

## Camino eficiente observado y cómo reproducirlo

La guía normativa/operativa para este camino está en
[`spec/premise-1/efficiency.md`](../../spec/premise-1/efficiency.md). En
resumen: conserva evidencia versionada, haz el `check` sobre el estado local,
agrupa revalidaciones por fuente, usa CAS únicamente en el write y trata los
tokens no expuestos como `unknown`.

El informe ciego generado localmente de la campaña de clones reales está en
`benchmarks/premisebench-agent/artifacts/real-campaign/` (ignorado por Git).
En el control inicial, el brazo ganador anónimo contiene 14 tareas, 27
peticiones instrumentadas, 23 lecturas locales y 0 errores. Tras las tres olas
de mejora, la misma política obtuvo 7 peticiones y 2 lecturas en round-3,
manteniendo 14/14 tareas correctas y seguras. Esto representa una reducción
observada de operaciones del arnés del 74,1% y 91,3%, respectivamente; no es
una reducción demostrada de coste monetario. Los identificadores se regeneran
por ronda para no convertir el estudio en una comparación longitudinal
adaptable.

También se ejecutó un piloto separado con tres agentes Luna Max y un examinador
ciego sobre cuatro tareas estables de los mismos repositorios. Los tres brazos
respondieron 4/4 correctamente; el número de peticiones por tarea fue 12, 4 y
3. Los tokens son `unknown`, y al no haber mutación en ese piloto no permite
inferir seguridad ante cambios. No se deben combinar sus cifras con las cuatro
rondas de 14 tareas.

Resumen legible de la campaña, con la identidad de los brazos revelada solo
después de cerrar la evaluación ciega:

| Ejecución | PREMiSE: peticiones / lecturas | Memoria básica | Memoria mejorada | Calidad PREMiSE |
| --- | ---: | ---: | ---: | ---: |
| Control round-0 | 27 / 23 | 25 / 21; 12/14 | 44 / 36; 12/14 | 14/14 |
| Mejora round-1 | 9 / 4 | 25 / 21; 12/14 | 44 / 36; 12/14 | 14/14 |
| Mejora round-2 | 7 / 2 | 25 / 21; 12/14 | 44 / 36; 12/14 | 14/14 |
| Mejora round-3 | 7 / 2 | 25 / 21; 12/14 | 44 / 36; 12/14 | 14/14 |
| Piloto Luna real (4 tareas) | 12 / tarea | 4 / tarea; 4/4 | 3 / tarea; 4/4 | 4/4 |

En las cuatro primeras filas, cada par es `peticiones / lecturas` totales de
14 tareas. En la última fila son operaciones por tarea de agentes reales. La
tabla no convierte esas operaciones en tokens, euros ni llamadas de red.

El informe marca `tokenTelemetry: "unknown"` y deja los campos de tokens en
`null`; no se rellena esa ausencia con una estimación.

En estas métricas, `requests` cuenta las operaciones enviadas al mundo y
`reads` es el subconjunto que lee, consulta o revalida. Las lecturas locales de
envelopes, estados y dependencias deben medirse aparte: no son tráfico del
conector. `check` tampoco convierte una lectura local en una revalidación
externa. Por eso una implementación debe publicar ambos contadores, además
de cualquier contador local, sin combinarlos en una única cifra.

La secuencia de una tarea es:

1. leer el envelope y resolver dependencias localmente;
2. ejecutar `check`; bloquear en `REJECT` y preparar solo en `USE`;
3. si hace falta, agrupar la revalidación, actualizar evidencia y repetir el
   `check` local;
4. escribir con la versión esperada mediante CAS; ante conflicto, no contar la
   acción como aplicada, reobservar y reintentar o rechazar;
5. conservar commit, manifiesto, `taskSetHash`, `inputSha256` y artefactos de
   la campaña.

El agrupamiento reduce llamadas repetidas, pero no cambia la semántica:
`UNKNOWN` sigue llevando a `REJECT`, un token sigue siendo opaco y un `check`
local por sí solo no protege contra TOCTOU. Los contadores y el resultado
anterior describen únicamente el artefacto citado, no un porcentaje o coste
generalizable.

Las tasas usan todas las tareas como denominador y no eliminan errores ni
resultados desfavorables. Los requests y tokens no deben mezclarse en una
media única entre smoke y live. Un resultado live también debe reportar dinero
real, tokens y errores de transporte cuando estén disponibles; no se debe
inferir USD a partir de requests.

## Cómo se ejecuta

### Smoke reproducible

```powershell
pnpm benchmark:premisebench:smoke
pnpm benchmark:premisebench:self-check
node --test benchmarks/premisebench-agent/scenarios/toctou.test.mjs
```

Las órdenes equivalentes, útiles para fijar otra cantidad de tareas o semilla,
son:

```powershell
node benchmarks/premisebench-agent/runner.mjs --tasks=100 --seed=20260811
node benchmarks/premisebench-agent/self-check.mjs
```

El runner ejecuta las ocho políticas en el orden A–H. Para cada tarea:

1. `tasks.mjs` fija la familia, el estado inicial, la mutación, la ventana de
   mutación y `cacheAge` a partir de la semilla.
2. `filesystem.mjs` crea un directorio temporal, escribe el estado inicial y
   expone lectura, acción, rechazo y `actIfVersion`.
3. El runner hace una lectura inicial y construye `agentInput` sin mutación,
   resultado esperado ni etiqueta del evaluador; `noOracle` falla si detecta
   campos de oráculo.
4. La mutación controlada ocurre antes de la acción o durante el write,
   según la familia. Solo `actIfVersion` puede rechazar atómicamente una
   versión que ya no coincide.
5. El mundo evalúa el estado final y el runner escribe los resúmenes, tablas,
   trazas y manifiestos en `benchmarks/premisebench-agent/artifacts/`.
6. `self-check.mjs` comprueba los artefactos obligatorios, las ocho políticas,
   el proveedor determinista y la ausencia de campos de oráculo en cada
   `agentInput`. `security/oracle-leakage.mjs` repite la comprobación sobre
   todas las trazas; `scripts/premisebench-agent/check-artifacts.mjs` confirma
   que los artefactos generados no están trackeados; y
   `scripts/premisebench-agent/check-claims.mjs` comprueba que la documentación
   conserva `deterministic-control`, `200` y la regla `NOT_RUN`.

El comando de smoke no necesita red, credenciales, base de datos ni modelo.
El repositorio fija Node 24.x como engine y dispone de un gate específico en
`scripts/premisebench-agent/node24-check.mjs`. La latencia puede variar entre
ejecuciones aunque la semántica de las familias y el orden de las tareas estén
fijados por la semilla.

### Smoke y live no son el mismo claim

| Dimensión | Smoke | Live |
| --- | --- | --- |
| Mundo | Filesystem temporal aislado. | Fuente externa o target controlado mediante un adapter. |
| Agente/proveedor | `deterministic-control`; no hay modelo. | Proveedor real, con tokens y coste observados. |
| Mutación | Guion determinista antes de la acción o durante el write. | Cambio externo controlado y versionado; debe declararse cómo se controla. |
| Credenciales/red | No requiere ninguna. | Opt-in explícito; un secreto o target ausente produce `NOT_RUN`. |
| Holdout | No existe (`holdout: false`). | Debe existir holdout ciego e independiente antes de un claim de proveedor. |
| Lectura correcta | Valida arnés, aislamiento y CAS. | Puede aportar evidencia de integración, recuperación y coste si cumple el diseño live. |

El manifiesto de diseño exige para una campaña live: al menos 200 tareas por
campaña, los mundos filesystem/GitHub/PostgreSQL, varios seeds, tres
proveedores cuando haya credenciales, holdout ciego preregistrado, intervalos
de confianza bootstrap por tarea y publicación de resultados negativos y
`NOT_RUN`. No se puede alcanzar ese umbral rellenando tareas smoke o
mezclando sus promedios con los de una fuente real.

Los adapters disponibles dejan explícitos sus límites:

- [`github.mjs`](../../benchmarks/premisebench-agent/worlds/github.mjs) hace
  lecturas GitHub y el mundo por defecto es read-only; no incluye un driver de
  mutación controlada. El ETag o blob SHA, ref, status HTTP, permisos y
  rate-limit deben conservarse; 401/403/404 o rate-limit no son un PASS.
- [`postgres.mjs`](../../benchmarks/premisebench-agent/worlds/postgres.mjs)
  requiere `DATABASE_URL`, `PREMISE_PG_TABLE`, `PREMISE_PG_ID` y
  `PREMISE_PG_VERSION_COLUMN`; no crea tablas ni ejecuta migraciones, valida
  identificadores y parametriza valores. Su `actIfVersion` está pensado para
  un target controlado y la sonda `probePostgresRead` solo demuestra lectura.
- El runner de este benchmark solo construye el mundo filesystem. No existe
  una bandera `--live` que convierta automáticamente una ejecución en una
  campaña GitHub/PostgreSQL. Una integración que todavía no tenga target,
  credenciales o driver de mutación debe publicarse como `NOT_RUN`, nunca como
  `PASS`.

La sonda opt-in disponible para reachability es:

```powershell
pnpm benchmark:premisebench:live-smoke
```

Devuelve JSON con `mutation: "NOT_RUN"` y el estado separado de GitHub y
PostgreSQL. Un `PASS_READ_ONLY` solo demuestra que el conector pudo leer el
target configurado y observar una versión. Para un claim de stale-action
prevention hace falta un repositorio/row temporal o disposable, una mutación
controlada, cleanup/rollback registrado, un proceso agente ciego y trazas del
evaluador no visibles al agente; la checklist detallada está en
[`worlds/live-review.md`](../../benchmarks/premisebench-agent/worlds/live-review.md).

## Límites y uso responsable

- 100 tareas, una semilla y cuatro familias sí permiten calcular el bootstrap
  que el runner publica, pero esos intervalos describen este corpus
  determinista; no sustituyen un holdout externo ni representan tráfico de
  producción.
- El evaluador está en el mismo proceso que el runner; ocultar el oráculo del
  `agentInput` no equivale a un holdout externo o a una auditoría independiente.
- `tokensPerTask: 0` es correcto para el control determinista y no informa del
  coste de ningún modelo.
- Las acciones son simuladas por el mundo filesystem. Un `actIfVersion`
  correcto aquí no demuestra que una API, base de datos o sistema de archivos
  real ofrezca la misma atomicidad.
- Un probe live de lectura demuestra conectividad y forma de la respuesta, no
  recuperación tras una mutación ni eficacia de PREMiSE.
- Un resultado favorable en H no autoriza claims de GA, disponibilidad,
  seguridad general, calidad de agente o superioridad de coste.

La especificación de diseño experimental y la lista de baselines están en
[`DESIGN.md`](../../benchmarks/premisebench-agent/DESIGN.md) y
[`baselines.mjs`](../../benchmarks/premisebench-agent/baselines.mjs). Para la
semántica normativa de `premise/1`, véase
[`docs/protocol/premise-1.md`](../protocol/premise-1.md).
