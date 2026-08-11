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
