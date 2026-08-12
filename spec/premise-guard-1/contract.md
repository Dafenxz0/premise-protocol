# Contrato normativo PREMiSE Guard `premise-guard/1`

## 1. Alcance

Este contrato fija una garantía portable para una acción que usa memoria o
estado respaldado por PREMiSE. No transporta contenido, no decide la verdad de
una fuente y no sustituye `premise/1`; enlaza una decisión de uso con una
acción concreta y con el estado que debe seguir vigente cuando la acción se
compromete.

La representación wire es JSON y MUST ajustarse a
[`contract.schema.json`](./contract.schema.json). Un consumidor MUST rechazar
`specVersion` distinto de `premise-guard/1`, campos desconocidos y mensajes
que no cumplan el schema, antes de producir efectos.

Los cuatro mensajes principales son:

| `kind` | Emisor | Función |
| --- | --- | --- |
| `GuardIntent` | Caller | Describe la acción y sus memorias raíz. |
| `GuardReceipt` | Guard | Atesta una decisión `USE` para un slice exacto, con expiración y lease. |
| `ConditionalAction` | Caller/adapter | Solicita el commit con precondiciones CAS y el receipt enlazado. |
| `ActionResult` | Adapter | Devuelve `APPLIED`, `REPLAY` o `REJECTED`. |

`GuardCapabilities` declara si un adapter puede cumplir las primitivas. Para
una acción protegida, `CAS`, `IDEMPOTENCY` y `FENCING` son obligatorias.

## 2. Identidad, digest y reloj

Todos los IDs son cadenas no vacías. `tenantId` forma parte de toda clave y
todo digest de identidad; un ID de otro tenant MUST rechazarse.

Un digest tiene la forma `sha256:` seguida de 64 hexadecimales minúsculos. Los
digests normativos se calculan sobre la representación JSON canónica JCS
(RFC 8785), codificada como UTF-8, omitiendo el propio campo digest. El
`intentDigest` es el digest del `GuardIntent`; `slice.digest` es el digest del
objeto slice sin `digest`; `receiptDigest` es el digest del `GuardReceipt` sin
`receiptDigest`.

Las fechas son instantes UTC RFC 3339. El reloj de validación y el reloj de
commit MUST consultar la autoridad que controla el lease; la hora del caller
no puede extender un receipt ni un lease.

## 3. `GuardIntent`

Un intent MUST contener:

- `tenantId`, `intentId`, `idempotencyKey` y `requestedAt`;
- `memoryIds`, con las memorias raíz que la acción usará directa o
  indirectamente;
- `action`, con `actionId`, `kind`, `target` y `requestDigest`.

`action.requestDigest` identifica de forma inmutable la acción completa,
incluidos sus parámetros y destino. El contrato no exige transportar esos
parámetros; si se transportan, el digest MUST cubrirlos. El mismo intent no
puede cambiar de acción después de emitir un receipt.

El intent es una solicitud, no una autorización. Una implementación MUST NOT
ejecutar `action` solo porque recibió un intent o porque una lectura anterior
declaró `FRESH`.

## 4. Action-critical slice

El *action-critical slice* es el conjunto mínimo y completo de observaciones
que puede cambiar la seguridad de la acción. El Guard MUST construirlo a
partir de `memoryIds` y MUST incluir:

1. cada memoria raíz;
2. la clausura transitiva de todos sus `dependsOn` actuales;
3. para cada memoria, su `status`, `incarnation`, `revision`, dependencias y
   todas las versiones de fuente y validators que sustentan la decisión;
4. cada recurso que la acción vaya a leer, modificar, borrar o enviar, con su
   `incarnation` y `revision` actuales;
5. cualquier otra condición que el propio adapter use para decidir si la
   acción es segura, incluida una decisión externa si existe.

El slice wire de un receipt tiene `complete: true`, `rootMemoryIds`,
`memories`, `resources` y `digest`. Sus invariantes son:

- todas las `rootMemoryIds` aparecen en `memories`;
- todas las memorias de `dependsOn` aparecen en el mismo slice;
- no hay IDs duplicados ni dependencias cruzadas de tenant;
- cada memoria tiene `status: FRESH` y una pareja estable
  `(incarnation, revision)`;
- cada `sourceVersions` conserva `sourceUri`, esquema, token y momento de
  observación;
- cada recurso tiene una pareja estable `(incarnation, revision)`;
- el digest cubre el slice completo, no solo las raíces.

Si el Guard no puede enumerar una dependencia, fuente, recurso o condición
que influye en la acción, el slice es incompleto. Debe devolver una decisión
`REJECTED` con `SLICE_INCOMPLETE` y MUST NOT emitir un `GuardReceipt`. Un
adapter no puede convertir un slice parcial en `complete: true` ni declarar
que un subset está protegido.

El `sliceDigest` se enlaza en el receipt y se vuelve a comparar durante el
commit. Una implementación puede usar una representación interna distinta,
pero la proyección que firma o digiere MUST ser equivalente a esta semántica.

## 5. `GuardReceipt` y receipt binding

El Guard solo puede emitir un receipt cuando la validación de todas las raíces
y del slice produce `USE`. El receipt MUST enlazar, sin sustituciones:

```text
(tenantId, intentId, idempotencyKey, intentDigest, actionDigest,
 sliceDigest, receiptId, leaseId, fenceToken, issuedAt, expiresAt)
```

`GuardReceipt.decision` es exactamente `USE`. El receipt contiene:

- `intentDigest`, para que no pueda usarse con otro intent;
- `actionDigest`, para que no pueda usarse con otro payload o target;
- el slice completo, con `sliceDigest` exactamente igual a `slice.digest`;
- `issuedAt` y `expiresAt`;
- `lease.leaseId`, `lease.scope`, `lease.fenceToken` y `lease.expiresAt`;
- `receiptDigest`, que enlaza el documento completo.

El receipt expira si `now > expiresAt`, si `now > lease.expiresAt`, si el lease
fue revocado o si el token dejó de ser el token vigente del scope. Un commit
MUST comprobar estas condiciones en el momento de aplicar, no solo en el
momento de validar. Renovar la hora o copiar el receipt no lo hace nuevo.

Un receipt no es transferible entre tenants, intents, acciones, slices,
leases ni scopes.

## 6. CAS y conditional action

`ConditionalAction` MUST transportar el `action` exacto y un `receipt` que
repita `receiptId`, `receiptDigest`, `intentDigest`, `actionDigest`,
`sliceDigest`, `leaseId` y `fenceToken`. También MUST transportar las
precondiciones observadas:

- `conditions.sliceDigest`;
- para cada memoria, `memoryId`, `incarnation` y `revision`;
- para cada fuente, `sourceUri`, esquema y token;
- para cada recurso, `resourceId`, `incarnation` y `revision`;
- el `fenceToken` del lease.

El commit protegido MUST ser una única operación condicional atómica en la
autoridad que controla el estado protegido. Conceptualmente ejecuta:

```text
if idempotency key ya tiene el mismo actionDigest:
       devolver el resultado guardado como REPLAY
       no aplicar action
else if idempotency key ya tiene otro actionDigest:
       no aplicar action
       devolver IDEMPOTENCY_CONFLICT
else if receipt binding exacto
   and receipt/lease vigentes
   and fenceToken == token vigente
   and sliceDigest == slice actual
   and todos los tuples memory/source/resource coinciden
   and idempotency key puede reservarse atómicamente:
       aplicar action
       guardar resultado de idempotencia durablemente
       devolver APPLIED
else:
       no aplicar action
       devolver REJECTED
```

La comparación y la aplicación MUST ser indivisibles para el conjunto entero
del slice. Una lectura seguida de una escritura incondicional, un lock local,
un retry o una revalidación inmediatamente anterior no son CAS y no eliminan
TOCTOU.

Si una fuente o recurso no ofrece una operación condicional equivalente, el
adapter MUST rechazar la acción. No puede declarar una acción protegida si
compara solo una parte del slice o si verifica la versión después de escribir.

Un fallo de CAS exige una nueva observación, un nuevo intent y una nueva
validación. El caller MUST NOT reutilizar el receipt que falló.

## 7. Fencing

`fenceToken` es un entero positivo, monotónico por `lease.scope` y nunca se
reutiliza. El authority que concede un lease incrementa el token antes de
ceder el scope a otro holder. El commit solo acepta el token exacto que figura
en el receipt y que sigue vigente en la autoridad; un token menor, revocado o
perteneciente a un lease sustituido produce `FENCE_STALE`.

La `incarnation` es obligatoria además del `revision`. Borrar un recurso y
recrearlo con el mismo `resourceId` o con la misma revisión no conserva la
incarnation: el receipt antiguo MUST rechazarse con
`INCARNATION_MISMATCH` (o `CAS_MISMATCH`). El fencing no sustituye a CAS y CAS
no sustituye al fencing.

## 8. Idempotencia y replay

La clave de idempotencia se evalúa en el ámbito `(tenantId, idempotencyKey)`.
El registro debe ser durable y compartido por las réplicas que puedan
comprometer la misma acción.

- Primera combinación con `actionDigest`: aplica una sola vez y guarda el
  `ActionResult` completo.
- Misma combinación y mismo digest: devuelve el mismo resultado lógico como
  `REPLAY`, sin volver a ejecutar la acción ni incrementar sus efectos.
- Misma clave con otro `actionDigest`: devuelve `REJECTED` con
  `IDEMPOTENCY_CONFLICT`, sin ejecutar ninguna acción.

La reserva de la clave y el commit de la acción deben pertenecer a la misma
transacción o a una primitiva equivalente. Una memoria local de deduplicación
no satisface este contrato para un adapter distribuido.

## 9. Fail-closed y resultados

Un adapter que no anuncia `CAS` MUST fallar cerrado con `CAS_REQUIRED`. No
puede ejecutar una acción porque el receipt diga `USE`, porque tenga
`IDEMPOTENCY`, porque tenga un lock local o porque el backend acepte una
escritura incondicional. Para una garantía completa también son obligatorias
`IDEMPOTENCY` y `FENCING`; la ausencia de cualquiera produce rechazo de la
acción protegida.

Un commit aceptado devuelve `ActionResult.status: APPLIED`. Un replay devuelve
`REPLAY` y conserva el resultado de la primera aplicación. Todo otro camino
devuelve `REJECTED` y `effects: 0`. Como mínimo, las razones portables son:

| Razón | Cuándo |
| --- | --- |
| `CAS_REQUIRED` | El adapter no tiene CAS atómico. |
| `CAS_MISMATCH` | Cambió una revisión, versión o el digest del slice. |
| `SOURCE_CHANGED` | Cambió una fuente observada antes del commit. |
| `INCARNATION_MISMATCH` | El ID fue borrado y recreado. |
| `RECEIPT_EXPIRED` | El receipt ya no está vigente. |
| `LEASE_EXPIRED` | El lease expiró o fue revocado. |
| `FENCE_STALE` | Otro holder sustituyó el fence token. |
| `SLICE_INCOMPLETE` | Faltan dependencias o condiciones críticas. |
| `RECEIPT_BINDING_MISMATCH` | El receipt no corresponde al intent/acción/slice. |
| `IDEMPOTENCY_CONFLICT` | La clave ya pertenece a otra acción. |

Una operación rechazada MUST dejar sin cambios el recurso, el estado de
PREMiSE, el registro de idempotencia y la historia de efectos. El adapter MAY
registrar un intento de auditoría separado, pero ese registro no cuenta como
efecto de la acción y no puede hacerla parecer aplicada.

## 10. Conformidad mínima

Un adapter conforme debe validar el schema, conservar el binding completo,
enumerar el slice, disponer de CAS atómico, soportar idempotencia durable,
fencing monotónico y fallar cerrado. Los vectores de
[`vectors/manifest.json`](./vectors/manifest.json) son el corpus mínimo:
ningún vector negativo puede producir un efecto, y el vector de replay debe
producir exactamente un efecto para dos commits con la misma clave y digest.
