# Estados y transiciones

Los únicos estados normativos de `premise/1` son `FRESH`, `STALE`, `INVALID` y
`UNKNOWN`. El campo `validity.status` es una proyección verificable, no una
autorización para saltarse `check`.

| Estado | Significado | Uso directo |
| --- | --- | --- |
| `FRESH` | La evidencia declarada es actual y suficiente, y no hay dependencia que la degrade. | Puede llegar a `USE`. |
| `STALE` | La vigencia dejó de estar garantizada por señal, TTL o dependencia. | Debe revalidarse. |
| `INVALID` | El validator confirmó cambio/ausencia, hay una violación estructural o un conflicto abierto impide soporte actual. | No puede usarse. |
| `UNKNOWN` | No se pudo determinar la vigencia. | Se rechaza hasta obtener evidencia. |

## Prioridad

Cuando se combinan estados, la prioridad es exacta:

```text
INVALID > UNKNOWN > STALE > FRESH
```

La agregación de un derivado toma el máximo entre su estado directo y los
estados efectivos de sus dependencias. Una dependencia `INVALID` invalida al
derivado; sin `INVALID`, una `UNKNOWN` domina a `STALE`; sin ambas, una `STALE`
domina a `FRESH`.

## Transiciones permitidas

| Causa | Transición | Evento mínimo |
| --- | --- | --- |
| `register` con evidencia actual | nuevo → `FRESH` | `MemoryRegistered` |
| `register` sin evidencia directa pero con dependencias | nuevo → estado agregado | `MemoryRegistered` o `MemoryDerived` |
| señal de cambio de fuente | `FRESH`/`UNKNOWN`/`STALE` → `STALE` | `SourceChanged`, y `MemoryStaled` cuando cambia la proyección |
| TTL alcanzado | `FRESH` → `STALE` | `MemoryStaled` al observarlo; no requiere scheduler |
| validator `UNCHANGED` con versión registrada | `STALE`/`UNKNOWN` → `FRESH` | `MemoryRevalidated` |
| validator `UNKNOWN` | cualquier estado reparable → `UNKNOWN` | `MemoryRevalidated` |
| validator `CHANGED` o `MISSING` | estado distinto → `INVALID` | `MemoryRevalidated` o `MemoryInvalidated` según la proyección emitida |
| `replace` con nueva observación | `INVALID` → estado de la nueva observación | `MemoryReplaced` |

Una transición nunca degrada `INVALID` por un `signal` o por un
`UNCHANGED`. La reparación de `INVALID` requiere `replace` o una operación
equivalente explícita que cree una nueva observación/version. La historia de
la invalidación se conserva.

## Propagación

Para `A.dependsOn = [B]`, un cambio de `B` visita `A` y sus dependientes
alcanzables en orden determinista por `memoryId`. El algoritmo MUST:

1. validar que el grafo sigue siendo acíclico;
2. marcar el objetivo según la causa;
3. recalcular cada dependiente con la prioridad normativa;
4. emitir eventos solo para nodos cuya proyección cambió;
5. dejar intactas ramas no alcanzables.

Una dependencia faltante al registrar/derivar es un error de contrato; no se
trata como `UNKNOWN` silenciosamente.
