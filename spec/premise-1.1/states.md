# Estados y transiciones `premise/1.1`

## 1. Estados de un recurso

El registro lógico de un tenant tiene dos estados por `resourceId`:

| Estado | Significado |
| --- | --- |
| `ABSENT` | No existe una observación actual para el recurso. |
| `PRESENT` | Existe exactamente una observación actual, con encarnación, token, observationId y dependencias. |

`versionToken` no es un estado ordenable. Un cambio de token siempre se evalúa
contra el snapshot causal; no se acepta por ser lexicográficamente mayor.

## 2. Estados de una Premise Set

| Estado | Significado | Decisión posible |
| --- | --- | --- |
| `COHERENT` | El conjunto está cerrado, tenant-scoped, acíclico y coincide con su snapshot. | `USE` |
| `INCOHERENT` | El conjunto está formado pero una o más identidades o dependencias no coinciden con su snapshot. | `REVALIDATE` o `REJECT` |
| `INCOMPLETE` | Falta un miembro, una dependencia, una entrada del snapshot o la frontera solicitada no es exacta. | `REJECT` |

`INCOMPLETE` no se degrada a `INCOHERENT` para permitir una revalidación
parcial. La falta de una parte del contexto es una frontera de seguridad.

## 3. Transiciones de recursos

Las transiciones son atómicas por change set:

```text
ABSENT  --CREATE------> PRESENT(i1, v1, o1)
PRESENT --UPDATE------> PRESENT(i1, v2, o2)
PRESENT --REINCARNATE> PRESENT(i2, v1, o3)
PRESENT --DELETE------> ABSENT
```

Reglas:

1. `CREATE` solo es válido desde `ABSENT` y no puede declarar un recurso en
   su snapshot causal.
2. `UPDATE` solo conserva la encarnación observada y debe cambiar
   `observationId`; el token nuevo no se interpreta por orden.
3. `REINCARNATE` MUST cambiar `incarnationId` y `observationId`. Puede repetir
   `versionToken`, que es precisamente el caso ABA seguro.
4. `DELETE` no tiene `after` ni dependencias nuevas.
5. Si una precondición no coincide en cualquier cambio, todo el set queda
   `REJECTED`; ningún recurso pasa de estado.

## 4. Validación previa y orden

Antes de mutar, la implementación MUST:

1. validar el schema cerrado y `specVersion`;
2. comprobar que todos los tenants del documento coinciden;
3. comprobar unicidad por `resourceId`, `observationId` e identidad;
4. comprobar que el snapshot coincide con el estado actual;
5. comprobar acciones, encarnaciones y dependencias; y
6. comprobar que el grafo resultante es un DAG.

Solo después de esos seis pasos aplica los cambios, en orden ascendente por
`resourceId`, y genera un único receipt. Un fallo en los pasos 1--6 deja el
estado y los receipts previos intactos.

## 5. Receipts y replay

Un `APPLIED` deja el recurso en el estado indicado por `after` y el receipt
registra el snapshot causal de la aplicación. Un `REJECTED` no cambia ningún
estado. El retry exacto retorna el receipt anterior con disposición `REPLAY`,
sin volver a evaluar el change set. Un digest diferente para la misma clave
retorna `CONFLICT` y no crea otro receipt.

Una implementación MUST NOT reutilizar un receipt de otro tenant, aunque
coincidan `operationId` o `idempotencyKey`.
