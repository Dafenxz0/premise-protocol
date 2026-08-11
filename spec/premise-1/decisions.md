# Decisiones de uso

`check(memoryId)` es una operación de solo lectura. Devuelve una decisión
portable y, como mínimo, el estado efectivo que la produjo. No recupera
contenido, no cambia el estado y no emite eventos.

## Tabla normativa

| Estado efectivo | Decisión | Regla |
| --- | --- | --- |
| `FRESH` | `USE` | La evidencia y las dependencias permiten usar el recuerdo. |
| `STALE` | `REVALIDATE` | Debe comprobarse antes de usarlo. |
| `UNKNOWN` | `REJECT` | La falta de certeza no autoriza el uso actual. |
| `INVALID` | `REJECT` | No puede usarse como soporte actual. |
| ID no registrado | `REJECT` | No existe una base de validez que consultar. |

Un conflicto `OPEN`, una dependencia `INVALID` o una violación estructural
produce una decisión efectiva `REJECT`, aunque un campo no actualizado
declare `FRESH`. La decisión se calcula a partir del estado y del grafo
actuales, no de una etiqueta presentada por el caller.

## Gating

Un adapter que declara la capability `GATE` MUST ejecutar `check` antes de
realizar una acción que use el contenido. Debe:

- permitir la acción solo con `USE`;
- iniciar revalidación y no usar el contenido con `REVALIDATE`;
- bloquear la acción con `REJECT`;
- conservar `memoryId`, estado, decisión y razón en su propio rastro de
  auditoría si ofrece auditoría.

Un adapter sin `GATE` puede exponer datos, pero no puede afirmar que protegió
una acción con PREMiSE. `RETRIEVAL` tampoco cambia la decisión: solo filtra o
etiqueta resultados que otra capa ya recuperó.

## Revalidacion agrupada

La revalidacion puede agrupar memorias solo cuando comparten `sourceUri`,
tenant o ambito de autorizacion, contexto de consulta, politica de validez y
la version de fuente que se comprueba. El resultado debe poder atribuirse
completamente a cada envelope y sus dependencias.

No se puede agrupar si alguno de esos datos difiere, si la fuente exige
ordenacion o aislamiento por consumidor, si hay dependencias distintas, o si
un resultado parcial no permite decidir cada memoria por separado. En esos
casos se revalida individualmente. La agrupacion reduce trabajo externo, pero
no fusiona estados ni altera la tabla normativa: cada memoria conserva su
`USE`, `REVALIDATE` o `REJECT`.

## Escritura protegida

Una operacion de escritura debe seguir el patron `revalidate-and-act`:

1. revalidar la evidencia necesaria;
2. ejecutar `check` de nuevo;
3. escribir solo si la decision es `USE`, pasando al CAS la version o token
   observado por esa revalidacion.

`REVALIDATE` no permite escribir y `REJECT` bloquea la operacion. Un fallo de
CAS obliga a observar, actualizar y revalidar antes de reintentar; no se puede
reutilizar una decision `USE` anterior. Una lectura seguida de una escritura
incondicional no es equivalente a CAS.

## Coste desconocido

La ausencia de telemetria de coste no implica coste cero. Peticiones,
lecturas, tokens, latencia o dinero no observados deben conservarse como
`unknown`/`null`; no se imputan como `0` ni se usan para afirmar eficiencia.

## Forma portable

La respuesta conceptual de `check` es:

```json
{
  "memoryId": "memory:example:42",
  "status": "STALE",
  "decision": "REVALIDATE",
  "reason": "SOURCE_CHANGED"
}
```

`reason` es opcional y el vocabulario de razones puede ampliarse en una
versión negociada; `status` y `decision` no pueden reinterpretarse.
