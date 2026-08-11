# Campaña mutable de coste

Esta campaña compara tres estrategias sobre 100 o 200 tareas con cambios
controlados antes de actuar y durante el write:

| Brazo | Comportamiento |
| --- | --- |
| Memoria básica | Confía en la observación inicial. |
| Memoria mejorada convencional | Lee la fuente antes de cada acción, pero no usa CAS. |
| PREMiSE | Comprueba la evidencia local, revalida solo cuando está obsoleta y protege el write con CAS. |

La tabla publica peticiones de conector, lecturas, writes, recuperaciones,
escapes TOCTOU, tokens proxy y coste proxy. Los tokens y costes de proveedor
real permanecen `UNKNOWN/NOT_MEASURED` si no hay runtime de modelo conectado.

## Lectura pública de tokens y coste

Los informes publican dos vistas deliberadamente separadas:

- `agentVisibleTokenProxy`: entrada inicial del agente más los payloads de
  request/response de conectores. Excluye el payload local del runtime.
- `agentVisibleCostProxy`: coste sintético calculado sobre esa misma vista
  visible. Sirve para comparar campañas con una fórmula reproducible, pero no
  es billing del proveedor.

La vista completa `tokenProxyTotal` y `costProxyUsd` también incluye el trabajo
local medido del runtime. Por eso no deben confundirse estas cifras:

| Campo | Incluye | Qué significa | ¿Es factura? |
| --- | --- | --- | --- |
| `agentVisibleTokenProxy` | Entrada inicial + payload externo | Proxy de lo que cruza la frontera agente/conector | No |
| `agentVisibleCostProxy` | Coste proxy de la vista visible | Comparación reproducible de payloads | No |
| `tokenProxyTotal` | Vista visible + payload local | Contabilidad proxy completa de la campaña | No |
| `costProxyUsd` | Coste proxy de todas las bolsas | Escala sintética de comparación | No |
| `providerTokens` | Tokens declarados por el proveedor | Telemetría real del modelo | `UNKNOWN` en este control |
| `providerCostUsd` | Billing verificable | Coste monetario real | `UNKNOWN` en este control |

La lectura pública permite saber qué está midiendo el informe sin concederle
una precisión que no tiene. Un `agentVisibleTokenProxy` menor no demuestra por
sí solo menos tokens facturables: para afirmar eso hay que conectar un modelo,
capturar sus tokens reales y aportar evidencia de billing. Si esa evidencia no
existe, el resultado debe conservar `UNKNOWN/NOT_MEASURED`.

## Qué se mide y qué no se debe mezclar

La campaña conserva dos planos de telemetría. El primero es el del agente y
el proveedor: `agentCalls`, tokens de entrada, salida y total declarados por
el proveedor, y `providerCostUsd` cuando existe billing verificable. Esos son
los tokens que cruzan el límite del modelo y pueden ser facturables. Cada
llamada cuenta aunque falte su consumo.

El segundo es el del runtime: `localChecks`, envelopes, hashes, dependencias,
revalidaciones, reintentos, bytes de serialización y decisiones locales. Estas
operaciones se publican y no se esconden dentro de `requests`, pero no son
tokens del agente ni coste de inferencia mientras no se envíen al proveedor.
Si el runtime manda un payload al modelo, sus tokens pasan al primer plano; si
lo manda solo al conector, se registra como payload o petición del conector.
`tokenProxy` es únicamente una estimación reproducible del payload y no es
telemetría ni una factura.

Cada brazo debe exponer, como mínimo, `agentCalls`, tokens reales o su estado,
`connectorRequests`, `externalReads`, `externalWrites`, `localChecks`,
revalidaciones, reintentos, `tokenProxy` y `providerCostUsd`. Registrar menos
operaciones no convierte el brazo en más eficiente.

## Comparación con memoria convencional

La memoria básica y la memoria mejorada convencional reciben exactamente el
mismo conjunto de tareas, mutaciones, datos iniciales, modelo, proveedor,
prompt base, herramientas y límites. PREMiSE no recibe el calendario ni el
resultado dorado. Las filas se emparejan por tarea y publican calidad antes
que coste:

| Orden | Métricas |
| --- | --- |
| 1 | Tareas correctas, acciones inseguras y escapes TOCTOU |
| 2 | Llamadas y tokens reales del agente |
| 3 | Lecturas, writes y peticiones externas |
| 4 | Checks, revalidaciones, reintentos y payload local |
| 5 | Token proxy y coste facturado verificable |

Solo un brazo con cero acciones inseguras, cero escapes TOCTOU y la completitud
mínima declarada puede ganar por eficiencia. Se publican totales, mediana y
p95 por tarea y diferencias emparejadas. No se compara el `tokenProxy` de un
brazo con tokens reales de otro, ni se transforma una reducción de lecturas en
una promesa de ahorro del modelo.

## Convenciones de valores desconocidos

`UNKNOWN` significa que el brazo sí se ejecutó, la métrica es relevante, pero
no hay una lectura fiable o verificable. No significa cero y no entra en
promedios, rankings ni afirmaciones de ahorro. En concreto:

- tokens del agente `UNKNOWN`: se hizo o pudo hacerse una llamada, pero falta
  la telemetría del proveedor;
- `providerCostUsd = UNKNOWN`: no existe billing verificable; una tarifa de
  lista o coste proxy no se presenta como coste real;
- `NOT_RUN`: el brazo no se ejecutó;
- `NOT_APPLICABLE`: la métrica no tiene sentido en esa ejecución, como tokens
  de proveedor en un control determinista sin modelo.

El valor `0` solo se usa cuando la traza demuestra que no hubo esa operación.
Un informe con tokens o coste `UNKNOWN` puede comparar seguridad, lecturas y
payload proxy si están medidos de forma equivalente, pero no puede afirmar
que PREMiSE reduzca tokens facturables o dinero.

## Ejecución

```powershell
node benchmarks/premisebench-agent/mutation-campaign.mjs --tasks=100 --seed=20260811 --round=100-a
node benchmarks/premisebench-agent/mutation-campaign.mjs --tasks=200 --seed=20260812 --round=200-a
node --test benchmarks/premisebench-agent/mutation-campaign.test.mjs
```

Los resultados se escriben en `benchmarks/premisebench-agent/artifacts/`, que
está ignorado. Cada ronda conserva tres candidatos anónimos y un informe ciego.
El `manifest.json` público no contiene el calendario de mutaciones ni el
objetivo dorado del evaluador.

El coste proxy usa `0,15 USD / millón` de tokens de entrada y `0,60 USD /
millón` de salida únicamente como una escala comparativa reproducible. No es
una factura, ni una medición de tokens de un proveedor.

## Lectura histórica de `100-a`

`100-a` es un control determinista con 100 tareas y 50 mutaciones. Sirve para
calibrar la métrica y probar la semántica de revalidación; no es una ejecución
de un modelo ni una medición de llamadas de red.

La tabla conserva la primera ejecución, antes de separar el payload visible del
payload local del runtime. Los directorios de artefactos están ignorados y se
regeneran; por eso esta captura histórica no debe confundirse con el contenido
actual de un directorio `100-a` generado posteriormente.

| Estrategia | Tareas correctas | Acciones inseguras/100 | Escapes TOCTOU/100 | Peticiones externas | Lecturas externas | Tokens proxy/tarea | Coste proxy/100 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Memoria básica | 50/100 | 50 | 10 | 100 | 0 | 97,0 | 0,003480 USD |
| Memoria convencional | 90/100 | 10 | 10 | 200 | 100 | 154,6 | 0,006153 USD |
| PREMiSE | 100/100 | 0 | 0 | 160 | 50 | 190,6 | 0,006176 USD |

La memoria básica parece barata porque no comprueba cambios y falla en la
mitad de las tareas mutadas. La convencional lee más y todavía deja escapar
TOCTOU. PREMiSE es el único brazo seguro en esta ejecución y reduce las
lecturas externas frente a la convencional, pero su token proxy todavía no es
menor: esa es una deuda de optimización explícita para las siguientes rondas.

## Serie ejecutada y resultado comparable

Después del control inicial se hicieron cuatro olas de mejora con agentes Luna
Max, siempre conservando las mismas tres estrategias, las mutaciones y la
regla de elegibilidad. La progresión publicada es:

| Ronda | Tareas | PREMiSE: peticiones/100 | PREMiSE: lecturas/100 | Tokens visibles proxy/tarea | Coste visible proxy/100 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `100-a` — control inicial | 100 | 160 | 50 | no separado | 0,006176 USD total proxy |
| `100-b` — primera mejora | 100 | 140 | 50 | 167,5 | 0,003759 USD |
| `200-a` — segunda mejora | 200 | 140 | 50 | 167,1 | 0,003752 USD |
| `200-b` — tercera mejora | 200 | 140 | 50 | 167,1 | 0,003752 USD |
| `200-c` — cuarta mejora | 200 | 140 | 50 | **146,4** | **0,0034425 USD** |

La ronda final `200-c` contiene 200 tareas y 100 mutaciones: 100 estables,
40 reparables, 40 incompatibles y 20 TOCTOU. El examinador recibe candidatos
anónimos y no ve la identidad de la estrategia ni el calendario de mutaciones
en la entrada del agente.

| Estrategia | Correctas | Inseguras/100 | TOCTOU/100 | Peticiones/100 | Lecturas/100 | Tokens visibles proxy/tarea | Coste visible proxy/100 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Memoria básica | 50/100 | 50 | 10 | 100 | 0 | 118,0 | 0,001995 USD |
| Memoria mejorada convencional | 90/100 | 10 | 10 | 200 | 100 | 169,8 | 0,004581 USD |
| **PREMiSE** | **100/100** | **0** | **0** | **140** | **50** | **146,4** | **0,0034425 USD** |

Entre los brazos elegibles, PREMiSE termina con 30% menos peticiones, 50%
menos lecturas, 13,8% menos tokens visibles proxy y 24,9% menos coste visible
proxy que la memoria convencional. La memoria básica no es elegible: ahorra
operaciones porque actúa con evidencia obsoleta en 50 de cada 100 tareas.

Estos porcentajes son evidencia de este control determinista local. Los tokens
del proveedor y el coste facturado siguen siendo `UNKNOWN/NOT_MEASURED`; el
examinador local ciego no es un holdout externo independiente.

## Perfil de optimización que se evalúa

La mejora normativa se aplica antes de comparar coste:

1. un `check` local por acción;
2. cero lecturas externas adicionales cuando la evidencia está `FRESH`;
3. una lectura por fuente/contexto compatible cuando hace falta revalidar;
4. un CAS con la versión revalidada;
5. ante rechazo CAS, una nueva lectura y un único reintento en este perfil;
6. `REJECT`/`UNKNOWN` al superar el límite, sin reutilizar un `USE` antiguo.

Los checks locales no cuentan como peticiones externas. La tabla de cada ronda
debe publicar por separado `externalReads`, `externalWrites`,
`connectorRequests` y `localChecks`. `tokenProxy` es una escala determinista de
payloads; `providerTokens` y `providerCostUsd` son `UNKNOWN/NOT_MEASURED` hasta
que un runtime conectado aporte telemetría y evidencia de facturación.

La elegibilidad precede a la eficiencia: solo se comparan costes entre brazos
con cero acciones inseguras, cero escapes TOCTOU y al menos 95 tareas correctas.
Así, una estrategia no puede “ganar” el benchmark simplemente omitiendo las
revalidaciones.

Revisión de consistencia realizada sobre `100-a`: el control conserva
revalidación antes del write, CAS en cada acción, retry con versión nueva,
separación de checks locales y lecturas externas, y la distinción
`proxy-only`/billing real. No se añaden estados ni campos al contrato
`premise/1`, y los objetivos de evaluación permanecen fuera de la entrada del
agente.
