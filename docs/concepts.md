# PREMiSE v0.1: conceptos y semántica

> Documento W1-H. Los nombres de schemas y paquetes siguen el plan v0.1; la implementación de cada pieza pertenece a su ownership correspondiente.

PREMiSE separa el valor de un recuerdo de la evidencia que permite usarlo. La memoria conserva el valor; PREMiSE conserva y propaga metadata sobre su validez. Véanse también [Problema y límites](./problem.md) y [Arquitectura](./architecture.md).

## Memoria y envelope

Una **memoria** es el sistema que posee el contenido de un recuerdo, su persistencia principal y su retrieval. Un `memoryId` identifica ese recuerdo dentro del contrato PREMiSE, pero no obliga a PREMiSE a conocer o almacenar su contenido.

Un **validity envelope** es la metadata asociada al recuerdo. La forma conceptual de v0.1 es:

```json
{
  "specVersion": "premise/0.1",
  "memoryId": "memory:pr-42-ci",
  "contentDigest": "sha256:...",
  "provenance": [
    {
      "sourceUri": "github://acme/repo/pulls/42/checks",
      "observedAt": "2026-08-09T19:20:00Z",
      "version": {
        "scheme": "git.commit",
        "token": "abc123"
      },
      "validator": {
        "id": "github.pull-request",
        "operation": "getPR"
      }
    }
  ],
  "validity": {
    "status": "FRESH",
    "checkedAt": "2026-08-09T19:20:00Z",
    "policy": "VERSIONED"
  },
  "dependsOn": []
}
```

Campos con semántica propia:

- `specVersion` fija la versión del contrato que interpreta el envelope.
- `memoryId` referencia el recuerdo que sigue siendo propiedad de la memoria.
- `contentDigest` es opcional y permite asociar una huella al contenido sin trasladarlo a PREMiSE.
- `provenance` registra una o más observaciones de fuentes externas.
- `sourceUri` identifica la fuente; `observedAt` registra cuándo se observó.
- `version.scheme` y `version.token` describen la versión observada. El token es opaco para PREMiSE.
- `validator.id` y `validator.operation` identifican la operación que puede comprobar esa referencia.
- `validity` contiene `status`, `checkedAt` y `policy`.
- `dependsOn` contiene los `memoryId` de los recuerdos que soportan una conclusión derivada.

Los nombres canónicos de schemas del plan v0.1 son:

```text
spec/schemas/memory-envelope.schema.json
spec/schemas/source-reference.schema.json
spec/schemas/validation-result.schema.json
spec/schemas/premise-event.schema.json
spec/schemas/capabilities.schema.json
```

Esos archivos son la entrega exclusiva de W1-B. En el bootstrap actual se documentan sus nombres, pero todavía no se debe asumir que sus archivos o su implementación de validación existan.

## Estados de validez

| Estado | Significado normativo |
| --- | --- |
| `FRESH` | Existe evidencia actual suficiente para el envelope. |
| `STALE` | La frescura dejó de estar garantizada; debe revalidarse. |
| `INVALID` | Se confirmó que el soporte anterior cambió o desapareció. |
| `UNKNOWN` | No se pudo determinar la vigencia. |

Estos estados describen validez respecto de la evidencia declarada; no son una puntuación de confianza, una medida de calidad del texto ni una afirmación universal sobre el mundo.

Reglas de transición de v0.1:

- Una notificación de cambio, un TTL vencido o un cambio de epoch produce `STALE`.
- Un version token distinto o un recurso eliminado produce `INVALID`.
- Si el validator no puede determinar el estado, produce `UNKNOWN`.
- Una revalidación con el mismo version token puede restaurar `FRESH`.
- Invalidar no significa borrar: la memoria conserva el contenido y PREMiSE conserva la historia metadata.

## Políticas

| Política | Regla |
| --- | --- |
| `IMMUTABLE` | Solo cambia mediante invalidación explícita. |
| `VERSIONED` | Depende de un version token y un validator. |
| `TTL` | Pasa a `STALE` al expirar. |
| `MANUAL` | Requiere confirmación externa explícita. |

La política determina qué evidencia o acción puede cambiar el estado; no cambia la propiedad del contenido.

## Dependencias y derivados

Un recuerdo derivado contiene referencias `dependsOn` hacia los recuerdos que sostienen su conclusión. Por ejemplo, `memory:pr-42-mergeable` puede depender de `memory:pr-42-head`, `memory:pr-42-ci` y `memory:pr-42-approvals`.

Estas referencias forman un grafo dirigido acíclico. Los ciclos se rechazan porque impedirían una evaluación determinista de soporte. Cuando cambia un nodo, la invalidación o el marcado de estado solo alcanza a los nodos que son alcanzables desde ese nodo; los subgrafos no relacionados no se modifican.

Para un derivado, la propagación se evalúa con esta prioridad:

1. Si alguna dependencia es `INVALID`, el derivado es `INVALID`.
2. Si no hay `INVALID` y alguna dependencia es `UNKNOWN`, el derivado es `UNKNOWN`.
3. Si no hay ninguno de los anteriores y alguna dependencia es `STALE`, el derivado es `STALE`.
4. En ausencia de esas condiciones, no se introduce una degradación por dependencia.

La propagación no reescribe el contenido ni pretende inferir una dependencia que la memoria no declaró.

## Validators y resultados

Un **validator** comprueba una `source-reference` contra una fuente externa y devuelve un resultado normativo. Interpreta el significado de su `version.scheme`; PREMiSE trata el `version.token` como opaco.

| Resultado | Interpretación para el recuerdo observado |
| --- | --- |
| `UNCHANGED` | La versión es la misma; el recuerdo puede volver a `FRESH`. |
| `CHANGED` | La versión es distinta; el recuerdo anterior pasa a `INVALID`. |
| `MISSING` | El recurso ya no existe; el recuerdo pasa a `INVALID`. |
| `UNKNOWN` | No se pudo confirmar; el recuerdo pasa a `UNKNOWN`. |

El validator no almacena el recuerdo ni decide cómo se recupera. Los paquetes [`@premise/validator-filesystem`](../packages/validator-filesystem/) y [`@premise/validator-git`](../packages/validator-git/) están reservados para los validators de las olas posteriores; el plan no promete un adapter real de GitHub en v0.1.

## Eventos e historia

El catálogo de eventos de v0.1 es:

```text
MemoryRegistered
MemoryDerived
SourceChanged
MemoryStaled
MemoryInvalidated
MemoryRevalidated
MemoryReplaced
```

Los payloads exactos y sus restricciones pertenecen a `premise-event.schema.json` y a la especificación. Esta documentación fija el vocabulario, no añade campos no definidos por esos contratos. La historia debe poder consultarse sin borrar el recuerdo que la originó.

## Capabilities

Una implementación declara capacidades independientes:

| Capability | Qué demuestra |
| --- | --- |
| `RECORD` | Puede almacenar o asociar envelopes PREMiSE. |
| `DEPENDENCY` | Mantiene dependencias y propagación. |
| `REVALIDATION` | Ejecuta validators y actualiza estados. |
| `RETRIEVAL` | Filtra o etiqueta resultados según su vigencia. |
| `GATE` | Comprueba memorias requeridas antes de una acción. |

Para llamarse `PREMiSE-compatible v0.1`, una memoria debe implementar `RECORD`, `DEPENDENCY` y `REVALIDATION`. `RETRIEVAL` y `GATE` son capacidades recomendadas, pero deben declararse explícitamente y no se presuponen por estar presente el protocolo.

## Operaciones conceptuales

El protocolo define comportamiento, no un transporte RPC obligatorio. La interfaz conceptual es:

```ts
interface PremiseProtocol {
  register(envelope: MemoryEnvelope): Promise<void>;
  derive(envelope: DerivedMemoryEnvelope): Promise<void>;
  signal(event: SourceChange): Promise<PropagationReport>;
  validate(memoryIds: readonly string[]): Promise<ValidationReport>;
  check(memoryIds: readonly string[]): Promise<UsabilityReport>;
  history(memoryId: string): Promise<PremiseEvent[]>;
}
```

`check()` expresa la decisión de uso sin obligar a recuperar contenido:

```text
USABLE       Puede utilizarse.
REVALIDATE   Debe comprobarse antes de utilizarse.
REJECT       No debe utilizarse como soporte actual.
```

Un adapter puede decidir cómo mostrar un recuerdo histórico, pero no puede presentar un recuerdo `INVALID` como soporte actual.
