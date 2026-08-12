# Modelo y contrato `premise/1.1`

## 1. Identidad

Toda referencia pertenece a un único tenant. La identidad lógica y causal de
un estado es:

```text
(tenantId, resourceId, incarnationId, versionToken, observationId)
```

Los cinco valores se comparan por igualdad exacta; PREMiSE no ordena tokens.

| Campo | Regla normativa |
| --- | --- |
| `tenantId` | Ámbito de aislamiento. No puede faltar ni cambiar dentro de un documento. |
| `resourceId` | Identificador estable del recurso lógico dentro del tenant. Se conserva al recrear el recurso. |
| `incarnationId` | Identificador de una vida del recurso. Un borrado seguido de recreación MUST usar uno nuevo. |
| `versionToken` | Token opaco de la autoridad del recurso. Solo su igualdad exacta tiene significado. Puede repetirse en otra encarnación, pero MUST NOT reutilizarse dentro de la misma encarnación. |
| `observationId` | Identificador único e inmutable de una observación. MUST NOT reutilizarse dentro del tenant, aunque vuelva el mismo token. |

La pareja `(resourceId, incarnationId)` identifica el ciclo de vida; la pareja
`(versionToken, observationId)` identifica la observación concreta dentro de
ese ciclo. Por eso `resourceId=R, incarnationId=I2, versionToken=A` no es el
mismo estado que `resourceId=R, incarnationId=I1, versionToken=A`.

Un consumidor MUST conservar los cinco valores. No puede calcular
`incarnationId` a partir de `versionToken`, ni tratar un token repetido como
prueba de que dos observaciones son iguales.

## 2. Observaciones y dependencias

Una `observation` es la observación actual de un recurso. Tiene un array
`dependsOn` siempre presente, aunque esté vacío. Cada dependencia es una
referencia completa con `tenantId`, `resourceId`, `incarnationId`,
`versionToken` y `observationId`; no se permiten dependencias implícitamente
globales ni strings sin scope. Cada dependencia MUST incluir tambiÃ©n un array
`scopes` no vacÃ­o de rutas absolutas (`/`, `/head`, `/deploy/region` o
`/head/*`). El core compara esos scopes por igualdad en el wire; un adaptador
puede calcular cobertura diferencial, pero no relajar la igualdad de los cinco
identificadores.

Una dependencia `A -> B` significa que el valor de `A` solo es utilizable si la
observación exacta de `B` sigue siendo la que declara `A`. El grafo MUST ser un
DAG. Un ciclo, un auto-ciclo o una dependencia ausente se rechazan antes de
mutar estado.

El `tenantId` de la observación, de cada dependencia y del documento que la
contiene MUST coincidir. Una implementación MUST NOT consultar ni adjuntar una
dependencia de otro tenant para completar una Premise Set.

## 3. Snapshots causales

Un `causalSnapshot` es una fotografía nombrada de referencias exactas. Sus
`entries` son miembros con dependencias, no un contador ni un timestamp. Debe
contener como máximo una entrada por `(tenantId, resourceId)` y todos sus
elementos deben pertenecer al mismo tenant.

Para una Premise Set cerrada, el snapshot contiene exactamente el cierre de
dependencias de sus miembros. Para un change set, contiene la precondición
observada de cada recurso que se cambia y el cierre de las dependencias que el
change set usa. La implementación compara identidad y dependencias por
igualdad exacta; no acepta una coincidencia parcial de `versionToken`.

Un snapshot no se actualiza en sitio. Una operación posterior crea otro
`snapshotId` y conserva el anterior en el receipt o en la historia externa del
adaptador.

## 4. Premise Sets

Una `premiseSet` es un conjunto finito, cerrado y tenant-scoped de miembros.
Para ser válido:

1. `members` no está vacío y no contiene dos recursos distintos para la misma
   clave `(tenantId, resourceId)`;
2. cada dependencia apunta a un miembro del mismo tenant;
3. cada dependencia apunta a la identidad y los `scopes` exactos del miembro
   referenciado;
4. el grafo de miembros no tiene ciclos; y
5. `causalSnapshot.entries` contiene exactamente esos miembros y sus
   dependencias, con la misma identidad y la misma lista `dependsOn`.

La violación de 2--5 es `INCOMPLETE` o `INCOHERENT` según
[`decisions.md`](./decisions.md), nunca una autorización de uso. El orden de
`members`, `entries` y `dependsOn` es parte del wire; para resultados
deterministas el runner usa el orden por identificador indicado en el README.

## 5. Change sets

Un `changeSet` es una transacción declarativa. Tiene un `causalSnapshot` que
actúa como precondición y uno o más `changes`, cada uno con un `resourceId`, un
`action` y un estado `after` (salvo `DELETE`). Las acciones son:

| Acción | Precondición | Resultado |
| --- | --- | --- |
| `CREATE` | El recurso está ausente y no aparece en el snapshot. | Crea `after` como primera observación. |
| `UPDATE` | El recurso actual coincide con el snapshot y conserva `incarnationId`. | Reemplaza la versión con `after`. |
| `REINCARNATE` | El recurso actual coincide con el snapshot. | Crea una nueva encarnación; `versionToken` puede volver a un valor antiguo, pero `incarnationId` y `observationId` deben ser nuevos. |
| `DELETE` | El recurso actual coincide con el snapshot. | Lo deja ausente. |

Todas las precondiciones se validan antes de cualquier cambio. Si una falla,
se rechaza el change set completo: no hay aplicación parcial, no hay receipt de
éxito y el estado no cambia. Un `UPDATE` no puede cambiar de encarnación; para
eso debe usar `REINCARNATE`. Un `REINCARNATE` no puede conservar el
`incarnationId` ni el `observationId` anterior.

El orden de aplicación es el orden ascendente por `resourceId`, aunque el
resultado sea atómico. Los cambios que introducen dependencias deben incluir
las referencias en `dependsOn` y el snapshot de la precondición debe cubrirlas.

## 6. Operaciones y receipts

Una `operation` es `apply` o `check` y contiene `operationId`,
`idempotencyKey`, `requestDigest`, `requestedAt` y `tenantId`. El ámbito de
idempotencia es:

```text
(tenantId, operation, idempotencyKey)
```

- clave nueva y digest nuevo: se evalúa y, si es válida, se aplica;
- misma clave y mismo digest: disposición `REPLAY`, se devuelve el receipt
  original byte-a-byte y no se ejecuta de nuevo;
- misma clave y digest diferente: disposición `CONFLICT`, se rechaza sin
  receipt nuevo y sin mutación.

Para que el corpus sea reproducible, el `receiptId` canónico de una operación
es `receipt:<operationId>`, y el `decisionId` canónico de un `check` es
`decision:<operationId>`. Ambos son únicos dentro del tenant. Un receipt de
`apply` conserva el `changeSetId`, el snapshot causal observado, la coherencia,
la frontera y el resultado `APPLIED` o `REJECTED`.

El receipt de un replay es el mismo objeto del primer intento. La disposición
`REPLAY` pertenece al resultado del intento, no altera el objeto histórico.
Una implementación MUST conservar el receipt original al reportar un
`CONFLICT`.

## 7. Forma wire

Los documentos raíz tienen un `kind` discriminante:

| `kind` | Uso |
| --- | --- |
| `observation` | Observación independiente de un recurso. |
| `premiseSet` | Conjunto cerrado que puede evaluarse. |
| `changeSet` | Transacción y precondición causal. |
| `operation` | Solicitud `apply` o `check`. |
| `decision` | Resultado portable de `check`. |
| `receipt` | Resultado durable de `apply` y su precondición. |
| `capabilities` | Declaración del perfil soportado. |

Todos llevan exactamente `specVersion: "premise/1.1"`. El JSON Schema fija la
forma cerrada; este documento fija las igualdades y los efectos que el schema
no puede expresar.
