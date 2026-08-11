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
