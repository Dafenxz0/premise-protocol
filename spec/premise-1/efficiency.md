# Camino eficiente para `premise/1`

Este documento describe una forma eficiente de ejecutar un adapter compatible
con `premise/1`. No añade estados, decisiones ni campos al contrato. La base
normativa sigue siendo [`model.md`](./model.md), [`states.md`](./states.md) y
[`decisions.md`](./decisions.md).

## 1. Conservar evidencia versionada

Al registrar una observación, conserva un envelope con `evidenceId`,
`sourceUri`, `observedAt`, la pareja `version`/`validator` cuando exista,
`validity` y `dependsOn`. La versión identifica la observación, pero su
`token` es opaco: el adapter no debe parsearlo, ordenarlo, incrementarlo ni
adivinar su significado. La evidencia es metadata; el contenido permanece
fuera de `premise/1`.

La evidencia debe ser versionada en dos sentidos:

- el envelope conserva el token devuelto por la fuente;
- la ejecución conserva una referencia inmutable a la revisión de código,
  configuración, manifiesto y artefactos que produjo la medición.

Una nueva observación o una nueva campaña crea evidencia nueva. No se debe
reescribir la historia para hacer que una memoria antigua parezca actual.

## 2. Hacer primero el check local

`check(memoryId)` es una operación de solo lectura. Después de recuperar el
envelope local y sus dependencias, calcula la decisión localmente:

| Resultado de `check` | Camino |
| --- | --- |
| `USE` | Preparar la acción con la versión observada. |
| `REVALIDATE` | Agrupar la revalidación necesaria; no usar todavía el contenido. |
| `REJECT` | Bloquear la acción. Incluye `UNKNOWN`, `INVALID`, conflictos y dependencias inválidas. |

El check local evita pedir a la fuente una confirmación cuando el estado local
ya obliga a rechazar o permite preparar la operación. No es una garantía de
vigencia entre el check y el write: esa garantía requiere un write protegido.

## 3. Revalidar agrupadamente

Cuando varias memorias señalan la misma fuente, revalida una vez por fuente y
por observación necesaria, no una vez por cada consumidor. La agrupación debe:

1. deduplicar por `sourceUri` y el contexto que la fuente necesite;
2. conservar el token observado para cada evidencia;
3. aplicar el resultado a todos los envelopes afectados;
4. propagar cambios por el grafo en el orden normativo;
5. ejecutar `check` local después de actualizar el estado.

Solo se puede agrupar cuando las operaciones tienen el mismo `sourceUri`,
tenant o ambito de autorizacion, contexto de consulta, politica de validez y
version de fuente que se esta comprobando. Si cualquiera de esos datos difiere,
si la fuente exige una secuencia por consumidor, si las dependencias no son
iguales, o si el resultado no puede atribuirse de forma completa a cada
evidence envelope, no se puede agrupar: se revalida por separado.

Agrupar no significa mezclar tenants, ocultar errores ni aceptar un resultado
parcial como si fuera una revalidacion completa. Una fuente o token no
determinable produce `UNKNOWN` y, por tanto, `REJECT` hasta obtener evidencia
suficiente. El ahorro de peticiones es una optimizacion de la ejecucion; nunca
autoriza a cambiar `USE`, `REVALIDATE` o `REJECT`.

## 4. Usar CAS solo al escribir

El adapter puede hacer lecturas y checks locales sin CAS. En el punto de
escritura debe enviar la versión esperada al mecanismo atómico de la fuente
(compare-and-set, condición equivalente o transacción). Si la fuente rechaza
la versión esperada porque cambió:

1. no se cuenta ni se presenta la acción como aplicada;
2. se observa la nueva versión;
3. se actualiza y revalida el envelope afectado;
4. se reintenta solo si el resultado permite hacerlo, o se rechaza.

Un `check` correcto antes del write no elimina el TOCTOU. El CAS protege la
decisión en el momento que cambia el mundo. El adapter no debe simular CAS
con una lectura seguida de una escritura incondicional.

La operacion normativa es `revalidate-and-act`: revalidar, recalcular el
`check` y escribir unicamente si la decision resultante es `USE`, usando en el
write el token o version que produjo esa revalidacion. `REVALIDATE` no es
permiso para escribir y `REJECT` termina la operacion. Si el CAS falla, el
adapter debe volver a observar y revalidar antes de cualquier nuevo intento;
no puede reutilizar un `USE` anterior.

## 5. Tokens desconocidos

Si el runner, proveedor o conector no expone tokens, el valor correcto es
`unknown`; no se debe imputar cero, estimarlo ni derivarlo de peticiones o
lecturas. La ausencia de telemetría de tokens es distinta de cero tokens.

El informe ciego de la campaña real conserva precisamente esa distinción:
`tokenTelemetry` es `unknown` y `tokens`/`tokensPerTask` son `null`. La
eficiencia puede compararse con las métricas disponibles, pero no puede
convertirse en coste de inferencia.

La misma regla aplica a cualquier coste no observado: `unknown`/`null` no es
`0`. Si faltan contadores de peticiones, lecturas, tokens, latencia o dinero,
se informa como desconocido y no se suma a un total como cero ni se presenta
como evidencia de eficiencia.

## 6. Separar peticiones de lecturas locales

Registra al menos estas magnitudes por tarea y por campaña:

- `requests`: operaciones enviadas al mundo o conector, incluidas lecturas,
  revalidaciones y acciones;
- `reads`: subconjunto de peticiones que leen, consultan o revalidan una
  fuente;
- lecturas locales de envelopes, estados y dependencias, medidas aparte y no
  sumadas automáticamente a `requests`.

La distinción evita confundir una decisión local barata con tráfico externo.
En el informe ciego versionado en
`benchmarks/premisebench-agent/artifacts/real-campaign/round-0/blind-report.json`,
el resultado ganador anónimo registra 14 tareas, 27 `requests`, 23 `reads`, 0
errores y telemetría de tokens desconocida. Es evidencia de esa campaña y su
commit, no una cifra universal ni una promesa de coste.

Al publicar resultados, conserva el commit común, `taskSetHash`, `inputSha256`,
el manifiesto y los artefactos. Reporta `requests` y `reads` por separado; no
infieras dinero o tokens a partir de ninguno de los dos.

## 7. Perfil de ejecución mínima: `100-a`

Este perfil concreta una optimización de ejecución; no añade estados,
decisiones ni campos a `premise/1`. La seguridad es una condición previa a la
eficiencia: un brazo que actúa con evidencia obsoleta no puede ganar por hacer
menos peticiones.

El control determinista `100-a` contiene 100 tareas y 50 mutaciones (20
reparables, 20 incompatibles y 10 durante el write). Sus resultados de
referencia son:

| Brazo | Completadas | Inseguras/100 | TOCTOU/100 | Peticiones externas | Lecturas externas | Checks locales | Tokens proxy/tarea | Coste proxy/100 tareas |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Memoria básica | 50% | 50 | 10 | 100 | 0 | 0 | 97,0 | 0,003480 USD |
| Memoria convencional | 90% | 10 | 10 | 200 | 100 | 0 | 154,6 | 0,006153 USD |
| PREMiSE | 100% | 0 | 0 | 160 | 50 | 100 | 190,6 | 0,006176 USD |

La lectura correcta de la captura inicial de `100-a` es: PREMiSE fue el único
brazo elegible por seguridad y redujo las lecturas externas frente a la memoria
convencional, pero todavía no había separado el token proxy visible del trabajo
local. Esa captura es histórica; los artefactos de la campaña se regeneran y no
deben tratarse como snapshots inmutables.

Las rondas posteriores conservaron la misma semántica y redujeron el trabajo
visible sin convertir un `check` local en una garantía de vigencia:

| Ronda | Tareas | Peticiones PREMiSE/100 | Lecturas PREMiSE/100 | Tokens visibles proxy/tarea | Coste visible proxy/100 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `100-b` | 100 | 140 | 50 | 167,5 | 0,003759 USD |
| `200-a` | 200 | 140 | 50 | 167,1 | 0,003752 USD |
| `200-b` | 200 | 140 | 50 | 167,1 | 0,003752 USD |
| `200-c` | 200 | **140** | **50** | **146,4** | **0,0034425 USD** |

En `200-c`, PREMiSE mantuvo 100/100 tareas correctas y cero acciones
inseguras/escapes TOCTOU, frente a 90/100 y 10/100 respectivamente para la
memoria convencional. La comparación monetaria sigue siendo proxy: el
proveedor no estuvo conectado y `providerTokens`/`providerCostUsd` son
`UNKNOWN/NOT_MEASURED`.

### Reglas normativas de la ejecución mínima

Para una acción sobre una evidencia, un adapter compatible debe:

1. ejecutar un único `check` local antes de contactar con la fuente;
2. si el estado es `FRESH`, no hacer una lectura externa solo para confirmar y
   enviar el token observado en un único write protegido por CAS;
3. si el estado es `REVALIDATE`, agrupar una lectura por cada clave de fuente
   compatible y reutilizar su resultado para todas las evidencias del grupo;
4. recalcular `check` localmente después de cada revalidación, antes de escribir;
5. si el CAS rechaza el token, descartar el `USE` anterior, hacer una nueva
   revalidación y reintentar solo con el token nuevo; nunca reutilizar la
   decisión anterior;
6. terminar en `REJECT` o `UNKNOWN` cuando se alcance el límite de reintentos
   declarado por el adapter. El perfil de evaluación `100-a` usa como máximo
   un reintento; un límite mayor debe declararse en los resultados.

El presupuesto esperado por acción es, por tanto:

| Situación | Check local | Lecturas externas | Writes externos | Reintentos |
| --- | ---: | ---: | ---: | ---: |
| `FRESH` sin cambio observado | 1 | 0 | 1 CAS | 0 |
| Cambio detectado antes del write | 1 | 1 agrupada | 1 CAS | 0 |
| Cambio durante el write | 1 | 2 como máximo en `100-a` | 2 como máximo, el primero rechazado | 1 |

Estos son límites de ejecución por acción, no una promesa para cualquier
conector. Si la fuente no ofrece CAS o una condición atómica equivalente, el
adapter no puede declarar protección TOCTOU aunque haga pocas lecturas.

### Presupuesto de tokens y coste

El check local, la propagación de dependencias y la deduplicación no deben
provocar una llamada al modelo ni una lectura externa. Cuando exista un modelo,
el adapter debe enviar solo el contexto necesario para la decisión o para la
revalidación; el contenido estable no se repite en cada check local. La
agrupación no puede ocultar errores ni saltarse una revalidación requerida.

### Tokens visibles del agente frente al payload local

La telemetría separa lo que cruza el límite del agente/proveedor de lo que el
runtime procesa localmente. Son magnitudes distintas y no se pueden sustituir:

- `agentInputTokens`, `agentOutputTokens` y `agentTotalTokens` son los tokens
  que el proveedor declara para las entradas y salidas del agente. Incluyen el
  contexto, resultados de herramientas y respuestas que realmente atraviesan
  ese límite; pueden ser facturables según el proveedor.
- `agentCalls` cuenta cada llamada al modelo, incluso si el proveedor no
  devuelve su consumo. Una traza puede demostrar `agentCalls = 0`; no puede
  convertir una llamada sin telemetría en `agentTotalTokens = 0`.
- `runtimeLocalPayload` describe envelopes, hashes, dependencias, checks,
  deduplicación y decisiones que permanecen dentro del runtime. Se puede
  publicar en bytes u operaciones para que no quede oculto, pero no son tokens
  del agente ni coste de inferencia mientras no crucen el límite del proveedor.
- Si un payload local se envía al modelo, deja de ser local para esta medición:
  sus tokens se cuentan como entrada del agente. Si se envía solo a un
  conector, se cuenta como payload del conector, no como tokens del modelo.
- `tokenProxy` es una estimación determinista del payload. Sirve para comparar
  dos brazos con el mismo estimador, pero nunca sustituye la telemetría del
  proveedor ni prueba una factura.

Estos nombres son métricas del informe, no estados, decisiones ni campos nuevos
de `premise/1`. Todo informe debe conservar también las operaciones que las
produjeron: llamadas al agente, peticiones del conector, lecturas y writes
externos, checks locales, revalidaciones, reintentos y bytes del runtime.

### Comparación justa con memoria convencional

PREMiSE y la memoria convencional se comparan por tarea emparejada, con el
mismo commit de datos, semillas, mutaciones, modelo, proveedor, prompt base,
límite de salida, herramientas y presupuesto temporal. La única diferencia
experimental debe ser la estrategia de memoria y validación. El agente no
recibe el objetivo dorado ni el calendario de mutaciones.

La tabla publica, por brazo, seguridad y calidad antes que eficiencia:

1. tareas completadas, acciones inseguras y escapes TOCTOU;
2. `agentCalls` y tokens reales de entrada/salida/total;
3. `connectorRequests`, `externalReads`, `externalWrites` y recuperaciones;
4. `localChecks`, revalidaciones, reintentos y `runtimeLocalPayload`;
5. `tokenProxy` y coste facturado verificable, cada uno con su etiqueta.

Se comparan totales, mediana y p95 por tarea, además de la diferencia pareada
entre brazos. Nunca se compara el `tokenProxy` de PREMiSE con tokens reales de
la memoria convencional, ni se presenta un menor número de lecturas como
menor coste del modelo. Solo los brazos con cero acciones inseguras, cero
escapes TOCTOU y el umbral de completitud declarado pueden competir en
eficiencia.

### Significado de `UNKNOWN`

`UNKNOWN` significa que la ejecución ocurrió y la métrica sería relevante,
pero no existe una medición fiable o verificable. No significa cero, ausencia
de trabajo ni un valor favorable. En particular:

- `agentTotalTokens = UNKNOWN` significa que hubo o pudo haber una llamada al
  agente, pero no se obtuvo su uso de tokens;
- `providerCostUsd = UNKNOWN` significa que no hay billing verificable. Un
  precio de lista, una tarifa asumida o un coste proxy no lo convierten en
  coste facturado;
- `NOT_RUN` significa que el brazo no se ejecutó;
- `NOT_APPLICABLE` significa que la métrica no tiene definición en esa prueba,
  por ejemplo tokens de proveedor en un control puramente determinista.

Los valores desconocidos no se rellenan con cero, no entran en promedios ni
permiten afirmar una reducción de tokens o coste. El informe puede comparar
las métricas que sí estén observadas, pero debe marcar como no demostrada toda
conclusión que dependa de la métrica desconocida.

Cada informe debe separar:

- `externalReads`, `externalWrites` y `connectorRequests`: operaciones contra
  la fuente o el conector;
- `localChecks`: decisiones calculadas sin contacto externo;
- `tokenProxy`: estimación determinista del payload, útil solo para comparar
  brazos bajo la misma regla;
- `providerTokens`: tokens observados por el runtime del proveedor, o
  `UNKNOWN`/`null` si no existen;
- `providerCostUsd`: coste facturado verificable, o `UNKNOWN`/`null` si no hay
  billing real.

La selección del mejor brazo es lexicográfica: primero `unsafeActionsPer100 = 0`,
`toctouEscapesPer100 = 0` y `tasksCompletedPer100 >= 95`; solo entre los brazos
que cumplen esas condiciones se minimizan, en este orden, `externalReads`,
`connectorRequests`, `tokenProxyTotal` y `providerCostUsd`. Un valor ausente no
se convierte en cero ni permite declarar ahorro.

## Secuencia de referencia

```text
evidencia versionada
        -> check local
        -> (REJECT | preparar | agrupar revalidación)
        -> check local tras revalidar
        -> CAS únicamente en el write
        -> éxito o reobservación/rechazo
```

Esta secuencia mantiene la semántica de `premise/1`: solo `USE` permite
continuar, `REVALIDATE` exige comprobar y `REJECT` bloquea.
