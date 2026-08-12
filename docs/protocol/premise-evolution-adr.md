# ADR: evolución protocolaria de PREMiSE

- **Estado:** aceptado y congelado para implementación posterior
- **Fecha:** 2026-08-12
- **Ámbito:** contratos protocolarios, compatibilidad y límites de importación
- **Cambios de implementación:** ninguno en este ADR

## Contexto

El contrato normativo actual es [`premise/1`](../../spec/premise-1/README.md).
Es un contrato cerrado: exige `specVersion` exacto, conserva metadata de
evidencia y dependencias, define los estados `FRESH`, `STALE`, `INVALID` y
`UNKNOWN`, y fija `check` como una operación de solo lectura con decisiones
`USE`, `REVALIDATE` y `REJECT`. La capability `GATE` es opcional y la
atomicidad de una escritura pertenece al adapter y a su target, no al núcleo
del protocolo. Estas reglas también están resumidas en
[`docs/protocol/premise-1.md`](./premise-1.md).

El repositorio contiene además contratos distintos y no intercambiables:

- [`premise/0.1`](../../spec/premise-v0.1.md) es el contrato legacy.
- [`premise/2`](../../spec/v2/README.md) es un contrato aditivo separado, con
  migración explícita desde v0.1.
- [`spec/premise-1/`](../../spec/premise-1/) es la superficie normativa
  evidence-first que debe permanecer estable.

La evolución necesita añadir una frontera para extensiones, una política
portable y un guard de acciones sin convertir ninguna de esas capas en una
dependencia del contrato mínimo ni reinterpretar compatibilidad como
comparación de prefijos.

## Decisión

Se congelan cuatro superficies con identificadores independientes:

| Superficie | Responsabilidad congelada | Regla de compatibilidad |
| --- | --- | --- |
| `premise/1` | Contrato mínimo de envelopes, operaciones, eventos, estados, dependencias e idempotencia. | Inmutable. Solo acepta el identificador exacto `premise/1`. |
| `premise/1.1` | Nueva superficie wire aditiva para evolución del contrato base. | Identificador exacto y negociación explícita; no es alias de `premise/1`. |
| `premise-policy/1` | Contrato declarativo y puro que transforma una decisión protocolaria en una intención de política. | Contrato opcional, versionado por separado y sin efectos en el wire del núcleo. |
| `premise-guard/1` | Contrato de enforcement antes de una acción sobre el contenido protegido. | Capability/capa opcional; no puede afirmar protección si no ejecuta sus precondiciones. |

La palabra “superficie” significa un contrato que puede publicarse y
negociarse de forma independiente. No autoriza a cambiar el significado de
un contrato ya congelado.

### `premise/1` queda inmutable

Una implementación compatible con `premise/1` seguirá usando la definición
actual de [`model.md`](../../spec/premise-1/model.md),
[`states.md`](../../spec/premise-1/states.md),
[`decisions.md`](../../spec/premise-1/decisions.md) y
[`compatibility.md`](../../spec/premise-1/compatibility.md). En particular:

- `specVersion` debe ser exactamente `premise/1`; no se acepta
  `premise/1.1`, `premise/2` ni un contrato de policy/guard por coincidencia
  de prefijo.
- Los estados, su prioridad `INVALID > UNKNOWN > STALE > FRESH`, la semántica
  del DAG, la idempotencia `NEW`/`REPLAY`/`CONFLICT` y el historial append-only
  no cambian.
- `check` no muta estado ni emite eventos. `INVALID`, `UNKNOWN`, conflictos
  abiertos o dependencias inválidas nunca pueden producir `USE`.
- No se añaden campos al schema cerrado, capabilities obligatorias,
  operaciones, eventos, estados ni decisiones existentes.
- Una aclaración editorial que cambie la forma o la semántica no es un patch
  de `premise/1`: requiere una nueva superficie y su campaña de conformance.

Por tanto, cualquier código, schema, vector o README existente bajo la
superficie `premise/1` queda fuera de este ADR y no debe modificarse para
acomodar las superficies nuevas.

### `premise/1.1` es una evolución aditiva y wire-distinta

`premise/1.1` se define como un contrato nuevo, no como una relajación del
parser de `premise/1`. Es aditivo en garantías y semántica de seguridad, pero
no es un superset estructural de los campos de `premise/1`.

Sus invariantes son:

1. Identifica una observación por `(tenantId, resourceId, incarnationId,
   versionToken, observationId)`. `incarnationId` evita que una observación de
   una entidad borrada y recreada vuelva a ser válida por un ataque ABA.
2. Añade scopes, invalidación diferencial por `changedScopes`, receipts
   ligados a identidad, versión, scopes, validator, autorización y frontera
   causal, además de `PremiseSet` y una frontera mínima de revalidación.
3. Conserva la semántica de seguridad de los estados y decisiones:
   `FRESH`/`USE`, `STALE`/`REVALIDATE`, e `INVALID`/`UNKNOWN`/`REJECT`. No
   introduce otro significado para `FRESH`, `STALE`, `INVALID` o
   `UNKNOWN`, ni otra decisión que reemplace `USE`, `REVALIDATE` o `REJECT`.
4. Puede definir sus propios documentos wire (observación, receipt y
   `PremiseSet`) con schema cerrado. Los campos desconocidos siguen siendo un
   error; no hay un `additionalProperties` implícito para extensiones futuras.
5. No incorpora la definición de una policy ni la garantía de un guard dentro
   del envelope. Esas responsabilidades permanecen en
   `premise-policy/1` y `premise-guard/1`.
6. No convierte `premise/2` en una versión compatible por renombrado. La
   relación con v0.1 y v2 sigue requiriendo adapters explícitos.

La ausencia de una extensión no inventa evidencia, confianza, autorización ni
garantía de enforcement. En particular, `premise/1.1` no implementa CAS: la
acción condicional pertenece a `premise-guard/1`.

### `premise-policy/1` es una capa pura de decisión

`premise-policy/1` decide el presupuesto de coherencia y la reutilización
segura de trabajo alrededor de una decisión normalizada de PREMiSE. Puede
negociar capabilities, compartir una validación solo cuando coincide la clave
de alcance completa, coordinar single-flight y leases, y exigir fencing. No
escribe en PREMiSE, no emite eventos y no afirma que una fuente externa sea
verdadera.

Puede consumir observaciones/receipts de `premise/1.1`, pero su contrato es
independiente del envelope del core. Capabilities como identidad de recurso y
encarnación, token de versión, lectura por scope, change sets, frontera
causal, CAS y acción condicional no se presumen si no se anuncian.

Sus invariantes mínimas son monotónicas respecto del núcleo:

- `USE` puede mantenerse como permitido o restringirse por policy, pero una
  policy nunca puede convertir `REVALIDATE` o `REJECT` en permitido.
- `REVALIDATE` exige revalidación antes del uso; `REJECT` permanece bloqueado.
- Una policy no puede reparar `INVALID` o `UNKNOWN`, eliminar una hoja de la
  frontera crítica ni compartir una validación fuera de su tenant, recurso,
  encarnación, scopes, validator, autorización, policy o frontera causal.
- Una policy ausente, inválida, incompatible o no verificable no se trata como
  una policy permisiva.
- La policy no sustituye el `check` de PREMiSE ni puede alterar estados,
  dependencias o eventos.

La policy tiene su propio identificador exacto (`premise-policy/1`) y puede
evolucionar sin cambiar el wire de `premise/1` o `premise/1.1`.

### `premise-guard/1` es el límite de acción

`premise-guard/1` formaliza la capability `GATE` existente y hace explícita la
frontera entre una decisión portable y una escritura externa. Un guard
compatible debe:

1. recibir un intent con digest de acción, conjunto de premisas críticas,
   capability requerida y receipts esperados;
2. ejecutar `check` con el `memoryId` y tenant correctos y aplicar
   `premise-policy/1`, si la acción está sujeta a policy;
3. verificar identidad, encarnación, versión, scopes, autorización, frontera
   causal, lease y fencing token de cada receipt;
4. permitir solo la combinación `USE` + policy permisiva + capability de
   acción condicional disponible;
5. ante `REVALIDATE`, receipt expirado o conflicto de versión, revalidar y
   volver a comprobar antes de usar o escribir;
6. ante `REJECT`, policy ausente/inválida, slice incompleto, token cambiado,
   fencing replay o fallo de CAS, bloquear la acción sin ejecutar el efecto
   externo;
7. producir `ALLOW`/`COMMITTED` solo después de un commit condicional
   confirmado, y conservar en su auditoría, cuando la ofrezca, el intent,
   premisas, receipts, decisión, policy, razón y token observado.

El guard no convierte `check` en una transacción universal. La atomicidad,
CAS, `CONDITIONAL_ACTION`, `ATOMIC_BATCH`, retry y semántica de commit del
target siguen siendo responsabilidad del adapter/target. Si el target no
ofrece la precondición necesaria para impedir TOCTOU, el guard debe devolver
`UNSUPPORTED` y no comprometer la acción protegida.

## Dirección de imports

En el siguiente grafo `A → B` significa “el módulo o contrato A puede
importar la interfaz pública de B”:

```text
premise/1.1 ───────→ premise/1
premise-policy/1 ──→ premise/1.1
premise-guard/1 ───→ premise-policy/1
premise-guard/1 ───→ premise/1.1
```

La flecha del dibujo se lee como dependencia conceptual de capas: la forma
operativa equivalente para un sistema de módulos es la siguiente lista
normativa, que evita ambigüedad sobre el sentido de la flecha:

- `premise/1.1` puede importar o reutilizar tipos/semántica de `premise/1`;
  `premise/1` nunca importa `premise/1.1`.
- `premise-policy/1` consume la decisión normalizada expuesta por la
  superficie 1.1. Un consumidor de `premise/1` necesita un adapter explícito
  para llegar a esa forma; policy no modifica el núcleo.
- `premise-guard/1` puede importar `premise-policy/1` y la interfaz de
  decisión de `premise/1.1`; policy nunca importa guard.
- Ninguna superficie protocolaria importa retrieval, embeddings, una base de
  datos, un proveedor cloud, contenido de memoria o un adapter concreto.
- No se permiten imports inversos, ciclos, reexportaciones que hagan que
  `premise/1` conozca policy/guard ni acoplamiento de la API del núcleo a una
  implementación de enforcement.

Los adapters y las aplicaciones se sitúan por encima de estas superficies y
pueden importar el guard, pero ninguna de estas superficies importa una
implementación concreta:

```text
adapters / aplicaciones / targets → premise-guard/1 → premise-policy/1 → premise/1.1 → premise/1
```

La regla importante es que la dependencia solo va hacia contratos más bajos y
nunca vuelve al núcleo desde policy o guard.

## Compatibilidad, negociación y downgrade

Un downgrade es una conversión explícita entre contratos, no una aceptación
silenciosa de una versión futura. El adapter debe validar primero el origen,
validar después el resultado contra el destino y producir un informe de
pérdida. La conversión no puede mutar el documento de origen.

| Origen | Destino | Regla |
| --- | --- | --- |
| `premise/1` | `premise/1` | Interoperabilidad nativa; aplica el contrato actual. |
| `premise/1.1` | `premise/1.1` | Interoperabilidad nativa si ambos anuncian exactamente la superficie. |
| `premise/1` | `premise/1.1` | Upgrade explícito. Se conservan todos los datos disponibles; los campos nuevos quedan ausentes/desconocidos, nunca inventados. |
| `premise/1.1` | `premise/1` | Downgrade explícito con `lossReport` obligatorio. La proyección no puede representar `incarnationId`, dependencias por scope, change sets, receipts, snapshots causales, coherencia de `PremiseSet` ni `CONDITIONAL_ACTION`; solo se acepta si el consumidor autoriza esa pérdida y no depende de ella. |
| `premise/1.1` | `premise/1` con una extensión obligatoria o de enforcement | Rechazo `UNSAFE_DOWNGRADE`; no se elimina la extensión para aparentar compatibilidad. |
| `premise/0.1` o `premise/2` | cualquier superficie nueva | Adapter separado, validación de ambos contratos y declaración de pérdida. No se reutiliza el nombre como alias. |
| `premise-policy/1` o `premise-guard/1` ausente | acción protegida | No hay downgrade permisivo: sin policy verificable o sin guard capaz de cumplir CAS/revalidación, la acción protegida se bloquea o se declara explícitamente fuera de enforcement. |

Un downgrade nunca puede:

- convertir `INVALID`, `UNKNOWN`, un conflicto abierto, una dependencia
  inválida o `REJECT` en `USE`;
- ocultar la pérdida de `incarnationId`, scopes, change sets, receipts,
  snapshots causales, coherencia de `PremiseSet` o acción condicional;
- eliminar `tenantId`, `memoryId`, `dependsOn`, evidencia, versiones,
  validators, idempotencia o la historia necesaria para interpretar el
  resultado;
- eliminar una condición de policy/guard y conservar el claim de que la
  acción estuvo protegida;
- aceptar campos desconocidos, hacer comparación por prefijo o hacer una
  migración implícita durante una mutación.

El hecho de que dos documentos compartan el prefijo `premise/1` no prueba
compatibilidad wire. La negociación debe declarar la lista exacta de
superficies, capabilities y dirección de conversión.

## No-goals

Este ADR no pretende:

- modificar `premise/1`, `spec/premise-1/`, sus schemas, referencias, vectores,
  README o resultados de conformance;
- reemplazar `premise/2`, corregir el contrato legacy `premise/0.1` o unificar
  sus entrypoints;
- añadir retrieval, embeddings, ranking, vector DB, almacenamiento de
  contenido o una autoridad universal de verdad;
- inferir dependencias o decisiones con un LLM;
- convertir policy en una nueva fuente de validez ni guard en una garantía
  física sobre cualquier target;
- prometer criptografía verificada, durabilidad, exactamente-una-vez,
  transacciones distribuidas o disponibilidad que no declare el adapter;
- introducir estados, decisiones, operaciones o campos “temporales” en
  `premise/1` para evitar negociar una nueva superficie;
- implementar en este cambio los paquetes, schemas, endpoints, imports o
  vectores ejecutables de las tres superficies nuevas.

## Criterios de aceptación

La evolución no se considera lista para implementación hasta que una campaña
de conformance independiente demuestre todos estos criterios:

1. **Inmutabilidad:** el corpus y el comportamiento existente de
   `spec/premise-1/` pasan sin cambios; un consumidor 1 rechaza exactamente
   `premise/1.1`, `premise/2` y contratos policy/guard.
2. **Compatibilidad 1.1:** un documento 1.1 válido conserva los invariantes
   de seguridad y la tabla de decisiones de 1, y además valida identidad de
   encarnación, scopes, receipts y coherencia según su propio contrato; un
   campo desconocido o una semántica no declarada se rechaza.
3. **Import graph:** un chequeo estático prueba la dirección congelada,
   ausencia de ciclos y ausencia de imports desde `premise/1` hacia 1.1,
   policy o guard.
4. **Policy monotónica:** cada estado/decisión de la tabla de 1 produce una
   intención segura; policy no puede elevar `REVALIDATE`/`REJECT` a permitido.
5. **Guard seguro:** no hay efecto externo si falla `check`, policy, versión,
   tenant, revalidación o CAS; una acción permitida queda ligada al token
   observado en la última revalidación.
6. **Downgrade auditable:** toda conversión 1.1 → 1 declara origen, destino,
   `lossReport`, campos descartados y pérdida semántica; una pérdida que afecte
   seguridad o decisión termina en `UNSAFE_DOWNGRADE`.
7. **Degradación honesta:** sin policy o guard compatible se puede ofrecer
   metadata/lectura no protegida solo con el claim correspondiente; nunca se
   publica un claim `GATE` implícito.

### Vectores mínimos congelados

Estos cuatro casos son el corpus mínimo que deberá materializar la
implementación futura. Se incluyen aquí para fijar la intención sin editar
schemas ni código en este cambio:

| Vector | Entrada mínima | Resultado obligatorio |
| --- | --- | --- |
| `version-boundary` | Documento `specVersion: premise/1.1` enviado a un consumidor que solo anuncia `premise/1`. | Rechazo `UNSUPPORTED_SPEC_VERSION`, cero mutaciones y cero eventos. |
| `safe-downgrade` | Envelope 1.1 proyectado mediante adapter explícito para una lectura no protegida, con el `lossReport` aceptado por el consumidor. | Envelope 1 válido, `lossReport` presente con `incarnationId`/scopes/receipts no preservados y ningún claim de acción condicional. |
| `unsafe-downgrade` | Envelope 1.1 cuya coherencia, receipt, encarnación o acción condicional es necesaria para autorización, convertido a 1. | Rechazo `UNSAFE_DOWNGRADE`; el origen y el estado del destino no cambian. |
| `policy-guard-cas` | Un intent con receipt válido y capability CAS, seguido de un `VERSION_MISMATCH`. | La policy no permite uso previo; el guard devuelve `REVALIDATE`/`NOT_COMMITTED`, deja auditoría del token/razón y no produce efecto externo. |

Los vectores existentes de `premise/1` siguen siendo la referencia para
estados, propagación, decisiones, idempotencia, tenancy y rechazo TOCTOU; los
cuatro casos anteriores son una frontera adicional y no una sustitución.

## Consecuencias y handoff

La separación evita que una mejora de policy o guard obligue a versionar o
abrir el contrato mínimo, a cambio de exigir negociación y adapters explícitos.
También hace visible que “puedo calcular `USE`” y “puedo proteger una
escritura” son claims distintos.

La materialización de `premise/1.1`, `premise-policy/1` y
`premise-guard/1` requiere trabajo fuera del alcance de este ADR: definir sus
schemas y manifests, crear los módulos/imports, añadir los cuatro vectores
ejecutables y conectar una campaña de conformance. Ese trabajo debe hacerse en
un cambio posterior que respete esta dirección y no modifique la superficie
`premise/1` congelada.
