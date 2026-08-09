# PREMiSE v0.1 — especificación normativa

**Estado:** contrato semántico de `premise/0.1`.

PREMiSE es un protocolo protocol-first para que una memoria de agentes declare
si un recuerdo sigue respaldado por la evidencia que lo originó y propague ese
resultado a sus derivados. La memoria conserva el contenido, su almacenamiento
y su retrieval; PREMiSE conserva metadata, procedencia, dependencias, eventos y
resultados de validación. Un estado PREMiSE no es una afirmación universal de
verdad, calidad o confianza.

Las palabras **MUST**, **MUST NOT**, **SHOULD** y **MAY** son normativas. La
interfaz descrita aquí es conceptual: v0.1 no exige un transporte RPC ni una
implementación concreta.

## 1. Propósito y límites

PREMiSE MUST resolver cuatro preguntas portables: qué `memoryId` se observa,
qué `sourceUri` y `version` lo respaldan, de qué otros `memoryId` depende y si
puede usarse ahora. La memoria o su adapter declara explícitamente las
dependencias; PREMiSE MUST NOT inferirlas, resumirlas ni pedir a un LLM que las
descubra.

PREMiSE v0.1 MUST NOT ser una memoria principal, un sistema de retrieval, una
Vector DB, un índice semántico, un sistema de embeddings o ranking, un framework
de agentes, un dashboard, un servicio cloud, un transporte de red obligatorio,
ni un almacén del contenido. Tampoco define autenticación, autoridad global,
conflicto semántico, migración de contenido, scheduler o un adapter real de
GitHub. Los validators interpretan sus fuentes y `version.token`; para PREMiSE
ese token es opaco. Invalidar metadata MUST NOT borrar automáticamente el
contenido de la memoria.

## 2. Envelope y provenance

El envelope canónico es metadata JSON y MUST ajustarse a
`spec/schemas/memory-envelope.schema.json` con `additionalProperties: false`.
Sus nombres y reglas son:

| Campo | Regla |
| --- | --- |
| `specVersion` | MUST ser exactamente `premise/0.1`. |
| `memoryId` | MUST ser una cadena no vacía e identificar el recuerdo dentro de la memoria. |
| `contentDigest` | MAY aparecer; si aparece MUST tener forma `sha256:...`. No transporta el contenido. |
| `provenance` | MAY omitirse cuando el soporte está expresado por `dependsOn`; si aparece MUST contener al menos una entrada. Una observación directa MUST tener al menos una entrada. |
| `validity` | MUST contener `status`, `checkedAt` y `policy`. `status` es la proyección normativa, no una autorización para saltarse las reglas. |
| `dependsOn` | MUST existir y ser un array de `memoryId` únicos; `[]` expresa una memoria sin dependencias. |

Cada elemento de `provenance` es un `source-reference` y MUST contener
`sourceUri` no vacío y `observedAt` con formato `date-time`. `version` y
`validator` son opcionales como pareja: si aparece uno, MUST aparecer el otro.
`version` contiene `scheme` y `token`, ambos no vacíos; `validator` contiene
`id` y `operation`, ambos no vacíos. PREMiSE MUST conservar esos valores y no
interpretar el token. Si `validity.policy` es `VERSIONED`, `provenance` MUST
existir y cada referencia MUST incluir `version` y `validator`.

`validity.expiresAt` MUST existir si y solo si `policy` es `TTL`. Todos los
instantes se comparan como `date-time` UTC. El contenido del recuerdo queda
fuera del envelope.

## 3. Estados y políticas

Los únicos estados son `FRESH`, `STALE`, `INVALID` y `UNKNOWN`:

| Estado | Semántica normativa |
| --- | --- |
| `FRESH` | La evidencia declarada es actual y suficiente para el envelope y sus dependencias. |
| `STALE` | La frescura dejó de estar garantizada; debe comprobarse antes de usarlo. |
| `INVALID` | La evidencia fue confirmada como cambiada o ausente, o existe una violación estructural conocida. |
| `UNKNOWN` | No se pudo determinar la vigencia; falta evidencia o el validator no pudo decidir. |

La prioridad de agregación es exacta: `INVALID` > `UNKNOWN` > `STALE` >
`FRESH`. Una memoria recién registrada con evidencia actual puede ser
`FRESH`. `STALE` o `UNKNOWN` pueden repararse; un mismo `memoryId` ya
`INVALID` MUST conservar ese hecho en su historia y solo puede sustituirse por
una nueva observación/version mediante `MemoryReplaced`.

`validity.policy` MUST ser exactamente una de estas cuatro políticas:

- `IMMUTABLE`: el envelope y su evidencia no se sobrescriben. Un cambio de
  estado requiere un evento explícito; una nueva observación se registra como
  reemplazo y no borra la anterior.
- `VERSIONED`: la vigencia depende de `version.scheme`, `version.token` y su
  `validator`. Un token distinto invalida la observación anterior; la historia
  conserva ambas versiones.
- `TTL`: al alcanzar `expiresAt`, el estado pasa a `STALE` (en la evaluación
  de ese instante); no hace falta un scheduler. Una nueva observación debe
  aportar un nuevo `expiresAt`.
- `MANUAL`: no hay expiración automática; una confirmación externa explícita,
  una señal o un resultado de validator es necesaria para cambiar la vigencia.

Una notificación de cambio de fuente, un TTL vencido o un cambio de epoch
produce `STALE`. `CHANGED` y `MISSING` producen `INVALID`; `UNKNOWN` produce
`UNKNOWN`; `UNCHANGED` con el `version` registrado puede restaurar `FRESH`.
Ningún estado permite presentar `INVALID` como soporte actual.

## 4. Dependencias, propagación y ciclos

Cada relación `A.dependsOn = [B, ...]` es una arista de A hacia sus soportes.
El grafo de `memoryId` MUST ser un DAG. `derive` MUST rechazar una arista que
cree un ciclo, incluido un auto-ciclo; una operación rechazada MUST dejar sin
cambios estado e historia y emitir cero eventos, salvo que el vector indique
lo contrario. Un grafo importado que ya contenga un ciclo MUST rechazarse, no
recorrerse hasta convergencia ni resolverse con una heurística.

Cuando cambia un nodo, la propagación MUST visitar solo ese nodo y los
dependientes alcanzables desde él. Las ramas no relacionadas MUST permanecer
intactas. Para cada derivado, después de evaluar su propio estado, se aplica:

1. alguna dependencia `INVALID` ⇒ derivado `INVALID`;
2. si no, alguna dependencia `UNKNOWN` ⇒ derivado `UNKNOWN`;
3. si no, alguna dependencia `STALE` ⇒ derivado `STALE`;
4. si no, no se degrada por dependencia.

Los resultados de propagación se ordenan de forma determinista por
`memoryId`; el orden declarado de `dependsOn` se conserva cuando forma parte
del evento esperado. La propagación no reescribe contenido ni crea
dependencias implícitas.

## 5. Eventos e historia

Los eventos son historia metadata append-only y deben poder reproducirse en el
mismo orden. El vocabulario v0.1 es:

| Evento | Uso |
| --- | --- |
| `MemoryRegistered` | Aceptación de `register`. |
| `MemoryDerived` | Aceptación de `derive`, con el `dependsOn` exacto. |
| `SourceChanged` | Señal externa aceptada por `signal`. |
| `MemoryStaled` | Una memoria pasa a `STALE`. |
| `MemoryInvalidated` | Una memoria pasa a `INVALID`. |
| `MemoryRevalidated` | Una memoria vuelve a `FRESH` tras validación/confirmación. |
| `MemoryReplaced` | Una observación/version reemplaza explícitamente otra. |

Un cambio de estado puede producir el evento de transición correspondiente por
cada nodo afectado; nunca debe producir eventos para ramas ajenas. `check` y
`history` son de solo lectura y MUST emitir cero eventos. Una operación
rechazada MUST emitir cero eventos. La historia MUST conservar invalidaciones,
reemplazos y versiones anteriores; `history(memoryId)` devuelve esos eventos
sin exigir acceso al contenido.

## 6. Validator y resultados

`validate` recibe o solicita un `validation-result` para un `memoryId`. El
resultado MUST ajustarse a `spec/schemas/validation-result.schema.json`:
`memoryId`, `result` y `checkedAt` son obligatorios; `sourceUri` es opcional;
`version` es obligatorio para `UNCHANGED` y `CHANGED`.

Los únicos resultados son:

| `result` | Estado normativo |
| --- | --- |
| `UNCHANGED` | `status` MUST ser `FRESH`; con el `version` registrado puede reparar `STALE`/`UNKNOWN`. |
| `CHANGED` | `status` MUST ser `INVALID`; el token distinto invalida el recuerdo anterior. |
| `MISSING` | `status` MUST ser `INVALID`; la fuente ya no existe. |
| `UNKNOWN` | `status` MUST ser `UNKNOWN`; no autoriza uso. |

Un resultado inconsistente con estas reglas MUST rechazarse. El validator no
edita contenido, no decide retrieval y no convierte un token opaco en una
semántica de PREMiSE. `validate` conserva el resultado, recalcula el estado y
propaga el cambio.

## 7. Operaciones conceptuales

- `register(envelope)`: valida el envelope completo, crea un `memoryId` nuevo
  o acepta un replay idéntico, y emite `MemoryRegistered`. Un conflicto de
  `memoryId` MUST rechazarse sin mutación.
- `derive(envelope)`: exige `dependsOn` existentes, conserva exactamente sus
  `memoryId`, comprueba que no haya ciclo y emite `MemoryDerived`. El derivado
  hereda la prioridad de estados aunque alguno de sus soportes no sea `FRESH`.
- `signal(event)`: acepta un `SourceChanged` explícito, marca el objetivo
  `STALE` y propaga a sus dependientes. No se puede enviar un estado arbitrario
  para saltarse `INVALID`.
- `validate(memoryIds)`: aplica un `validation-result` por memoria, emite los
  eventos de transición necesarios y recalcula dependientes.
- `check(memoryIds)`: calcula sin efectos laterales la decisión de uso de cada
  memoria, sin recuperar contenido.
- `history(memoryId)`: devuelve la secuencia de eventos metadata de esa
  memoria; no modifica estado.

## 8. Decisiones y capabilities

`check` DEBE mapear estados exactamente así: `FRESH` ⇒ `USABLE`;
`STALE` o `UNKNOWN` ⇒ `REVALIDATE`; `INVALID` ⇒ `REJECT`. `USABLE` permite
utilizar el recuerdo bajo la política del adapter. `REVALIDATE` exige
comprobarlo antes de usarlo. `REJECT` prohíbe usarlo como soporte actual.

Las capabilities declarables son exactamente `RECORD`, `DEPENDENCY`,
`REVALIDATION`, `RETRIEVAL` y `GATE`:

- `RECORD` demuestra asociación de envelopes;
- `DEPENDENCY` demuestra grafo, ciclos rechazados y propagación;
- `REVALIDATION` demuestra validators, resultados y transiciones;
- `RETRIEVAL` demuestra filtrado/etiquetado de resultados ya proporcionados,
  no retrieval semántico propio;
- `GATE` demuestra la aplicación de `check` antes de una acción.

La declaración de compatibilidad PREMiSE v0.1 MUST incluir `RECORD`,
`DEPENDENCY` y `REVALIDATION`. `RETRIEVAL` y `GATE` son opcionales y MUST
declararse explícitamente. Un consumidor v0.1 MUST rechazar otro
`specVersion`, campos no permitidos por los schemas o capabilities requeridas
ausentes; MUST NOT degradarlos silenciosamente.

Una implementación es conforme cuando valida los tres schemas canónicos,
implementa las seis operaciones con estas transiciones, conserva provenance y
eventos, aplica la prioridad DAG y el rechazo de ciclos, produce decisiones
exactas `USABLE`/`REVALIDATE`/`REJECT`, deja intactas las ramas no alcanzables,
y reproduce determinísticamente los test vectors `premise/0.1`.
