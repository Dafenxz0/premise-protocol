# Modelo y contrato `premise/1`

## 1. Alcance

PREMiSE conserva metadata suficiente para responder si un recuerdo puede
usarse con la evidencia que lo respalda. El contenido, su almacenamiento y su
retrieval quedan fuera del contrato. PREMiSE MUST NOT inferir dependencias ni
interpretar el significado del contenido.

La representación wire es JSON y MUST ajustarse a
[`contract.schema.json`](./contract.schema.json), con campos desconocidos
rechazados. El esquema fija la forma; este documento fija la semántica.

## 2. Memory envelope

Un envelope MUST contener:

| Campo | Regla |
| --- | --- |
| `specVersion` | Exactamente `premise/1`. |
| `tenantId` | Identificador no vacío, sin espacios exteriores. Todos los IDs del envelope quedan dentro de este tenant. |
| `memoryId` | Cadena no vacía y estable dentro del tenant. |
| `evidence` | Array de observaciones. Debe ser no vacío para una memoria directa; puede estar vacío si `dependsOn` no está vacío. |
| `validity` | `{status, checkedAt, policy}` y, solo para `TTL`, `expiresAt`. |
| `dependsOn` | Array de IDs únicos; cada dependencia pertenece al mismo `tenantId`. |
| `contentDigest` | Opcional; si aparece, tiene forma `sha256:...` y no transporta contenido. |

Cada entrada de `evidence` MUST contener `evidenceId`, `sourceUri` y
`observedAt`. `evidenceId` es único dentro del envelope. `version` y
`validator` son opcionales como pareja: si se declara uno, MUST declararse el
otro. PREMiSE conserva ambos valores y trata `version.token` como opaco.

El envelope MAY declarar `confidence`, `conflicts`, `temporal` y `signatures`
según el esquema. Son extensiones del mismo contrato, no sustituyen a
`validity` ni autorizan una decisión distinta. Un conflicto `OPEN` impide
declarar `FRESH`; una firma declarada es metadata y no implica verificación
criptográfica por este contrato mínimo.

`validity.policy` solo puede ser:

- `IMMUTABLE`: no se sobrescribe la observación; una nueva observación usa
  `replace` y conserva la historia.
- `VERSIONED`: la vigencia depende de la pareja `version`/`validator`; una
  versión distinta invalida la observación anterior.
- `TTL`: al alcanzar `expiresAt`, el estado efectivo es `STALE`.
- `MANUAL`: no hay expiración automática; hace falta señal o validación
  explícita.

## 3. Operaciones

Una operación mutante MUST llevar `operationId`, `idempotencyKey`,
`requestDigest` con prefijo `sha256:`, `requestedAt`, `tenantId` y un
`payload`. Las operaciones conceptuales son:

| Operación | Efecto mínimo |
| --- | --- |
| `register` | Valida y registra un envelope nuevo; emite `MemoryRegistered`. |
| `derive` | Registra un envelope con dependencias existentes y sin ciclos; emite `MemoryDerived`. |
| `replace` | Sustituye explícitamente una observación `INVALID`; conserva la historia y emite `MemoryReplaced`. |
| `signal` | Acepta un cambio de fuente, marca `STALE` y propaga por el grafo. |
| `validate` | Aplica `UNCHANGED`, `CHANGED`, `MISSING` o `UNKNOWN` y recalcula dependientes. |
| `migrate` | Importa mediante un adaptador una versión soportada; no es conversión implícita. |
| `check` | Solo lectura: calcula la decisión de uso, sin eventos. |
| `history` | Solo lectura: devuelve la historia metadata, sin eventos. |

La clave de idempotencia se evalúa en el ámbito `(tenantId, operation,
idempotencyKey)`:

- clave nueva: `NEW` y se aplica la mutación;
- misma clave y mismo `requestDigest`: `REPLAY`, devuelve el resultado previo
  y no muta por segunda vez;
- misma clave y digest diferente: `CONFLICT`, se rechaza sin mutación.

Una operación rechazada por contrato, tenant, ciclo, conflicto de idempotencia
o dependencia ausente MUST producir cero eventos.

## 4. Eventos

Los eventos son historia append-only. Cada evento MUST incluir
`specVersion`, `tenantId`, `eventId`, `operationId`, `idempotencyKey`,
`requestDigest`, `type`, `occurredAt` y `payload`; los eventos que afectan a
un recuerdo incluyen `memoryId`.

El vocabulario mínimo es:

| Evento | Significado |
| --- | --- |
| `MemoryRegistered` | Registro aceptado. |
| `MemoryDerived` | Derivación aceptada con sus dependencias exactas. |
| `SourceChanged` | Señal externa de cambio aceptada. |
| `MemoryStaled` | Proyección pasó a `STALE`. |
| `MemoryInvalidated` | Proyección pasó a `INVALID`. |
| `MemoryRevalidated` | Resultado de validator aplicado. |
| `MemoryReplaced` | Nueva observación reemplazó explícitamente una inválida. |
| `MemoryMigrated` | Importación explícita desde una versión soportada. |

El orden del array de eventos es historia y MUST ser reproducible. `check` y
`history` no emiten eventos.

## 5. Revalidación y dependencias

Un resultado de validator debe identificar `memoryId`, `result` y `checkedAt`.
Los resultados tienen esta semántica exacta:

| Resultado | Estado directo |
| --- | --- |
| `UNCHANGED` | `FRESH` cuando la versión coincide; puede reparar `STALE` o `UNKNOWN`. |
| `CHANGED` | `INVALID`. |
| `MISSING` | `INVALID`. |
| `UNKNOWN` | `UNKNOWN`. |

`UNCHANGED` nunca repara silenciosamente `INVALID`; para ello se requiere
`replace` con una nueva observación válida.

Si `A.dependsOn` contiene `B`, la arista es `A → B` y la propagación recorre
la relación inversa. El grafo MUST ser un DAG. Un ciclo, incluido un auto-ciclo,
se rechaza antes de modificar estado. Para cada dependiente, la prioridad de
agregación es `INVALID > UNKNOWN > STALE > FRESH`.

La propagación solo visita el objetivo y los dependientes alcanzables. Las
ramas no relacionadas, el contenido y los envelopes históricos permanecen
intactos.
