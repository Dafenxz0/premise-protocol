# Decisiones de policy

`premise-policy/1` elige cuándo y cómo validar, pero no cambia la semántica de
`premise/1.1` ni autoriza por sí solo una acción. `premise-guard/1` sigue siendo
la autoridad para el slice crítico y el commit condicional.

## Resultados

| Resultado | Significado |
| --- | --- |
| `USE` | El core ve `FRESH` y todas las propiedades exigidas por la policy están verificadas. Un write aún necesita CAS/guard. |
| `REVALIDATE` | Falta una observación reparable, una frontera o un TTL vigente. No se usa el contenido mientras tanto. |
| `REJECT` | Identidad, evidencia, scope, coherencia, riesgo o commit impide actuar de forma segura. Cero efectos. |
| `UNSUPPORTED` | Falta una capability necesaria o el adapter no puede demostrarla. No hay downgrade silencioso. |

`ALLOW` es el resultado del guard después de comprobar receipts y commit; no es
un alias que la policy pueda devolver para saltarse el guard. `NEW`, `REPLAY`,
`CONFLICT`, `IN_PROGRESS`, `CAS_MISMATCH` y `FENCING_REPLAY` son resultados del
intento que acompañan a la decisión.

## Entrada y orden de evaluación

Una evaluación necesita al menos `specVersion`, operación, nivel de riesgo,
identidad, scope, capabilities anunciadas, propiedades de evidencia requeridas
y frontera esperada. El contenido nunca es evidencia de policy.

El orden obligatorio es:

1. comprobar `premise-policy/1` exacto y negociar todas las capabilities
   solicitadas;
2. comparar `(tenantId, resourceId, incarnationId)` y el contexto de
   autorización;
3. comprobar cada propiedad de evidencia contra el mismo sujeto y scope;
4. consultar la decisión del core y la clausura de dependencias;
5. comprobar `changeSet`, snapshot, batch y causal frontier;
6. aplicar límites de TTL y el nivel de riesgo;
7. resolver single-flight, sharing y lease si la operación los usa;
8. comprobar idempotency antes de repetir un write;
9. exigir CAS/`CONDITIONAL_ACTION` para cualquier efecto;
10. emitir evento y receipt solo después de un commit aceptado.

Un resultado posterior no puede reparar un fallo anterior: una candidate que
ahorra una lectura no puede borrar un miembro requerido de la frontier ni un
guard del core.

## Identidad y evidencia verificable

La identidad se compara como la tupla:

```text
(tenantId, resourceId, incarnationId)
```

`versionToken` es opaco y solo vale para esa tupla. Si se borra y recrea el
recurso, `incarnationId` cambia aunque la fuente vuelva a exponer el mismo
token. La observación anterior se rechaza por `IDENTITY_MISMATCH`; esto evita
ABA.

La evidencia se modela como propiedades, no como una puntuación global:

```text
property(subject, observation, verifier, observedAt, artifactDigest) = VERIFIED
```

El schema exige `evidenceId`, predicado, sujeto, resultado `VERIFIED`,
`observedAt`, verificador y digest `sha256:`. El verificador debe poder repetir
el predicado sobre el artefacto identificado. `UNKNOWN`, ausencia de digest,
scope diferente o un verificador no reproducible no cuentan como evidencia.

Una policy puede exigir más propiedades, pero nunca puede quitar las del core:
identidad, evidencia, scope, decisión conservadora y fail-closed. La ausencia
de telemetría o de coste es `UNKNOWN`, nunca cero.

## Lecturas condicionales y TTL fallback

`CONDITIONAL_READ` compara la identity completa y el token esperado. Los
resultados son:

| Resultado | Decisión |
| --- | --- |
| `MATCH` / `NOT_MODIFIED` | Puede conservarse la evidencia, sujeto a core y riesgo. |
| `MISMATCH` | `REVALIDATE`; un write preparado con el token viejo no puede continuar. |
| `GONE` o encarnación distinta | `REJECT`. |
| `UNKNOWN` | `REVALIDATE` en riesgo bajo/medio; `REJECT` o `UNSUPPORTED` en alto/crítico. |

`TTL_ONLY`/`UNVERSIONED` es un fallback explícito cuando la fuente no ofrece un
token. El TTL es un límite superior de frescura, no una prueba de inmutabilidad:

- antes de `expiresAt`, una lectura de riesgo bajo puede devolver `USE` si las
  demás propiedades están verificadas;
- al alcanzar `expiresAt`, la decisión es `REVALIDATE`;
- para writes, riesgo alto o crítico, el fallback nunca devuelve `USE`;
- un cache hit, snapshot viejo o retry no extiende el TTL;
- sin token y sin TTL acotado, la salida es `UNSUPPORTED`/`REJECT`.

El fallback no sustituye `CAS`, `CONDITIONAL_ACTION`, identidad, evidencia ni
guard.

## Change sets, snapshots, eventos y batch

Un `CHANGE_SET` tiene id, miembros requeridos, digest y frontera. Si falta un
miembro, su versión no se puede comparar o el resultado no se puede atribuir,
la salida es `CHANGE_SET_INCOMPLETE` y no `USE` parcial.

Un `TRANSACTION_SNAPSHOT` es inmutable y conserva identity, `capturedAt`, event
head y causal frontier. Sirve para repetir una lectura; por sí mismo no
autoriza un write. Un snapshot de otra encarnación o tenant es inválido.

Un `BATCH_READ` conserva una decisión, evidencia, token y error por item. El
batch debe declarar si es `per-item` o `all-or-nothing`; no puede convertir un
item faltante en éxito ni aplanar `REVALIDATE` a `USE`. `ATOMIC_BATCH` es
obligatorio cuando el core exige atomicidad; si falta, devuelve `UNSUPPORTED`.

`ORDERED_EVENTS` conserva eventos append-only, tenant, identity, operation,
idempotency key, request digest, causal frontier y orden. Una operación
rechazada antes del commit produce cero eventos. Un evento no es una prueba de
verdad externa: solo prueba que el hecho del evento fue aceptado por la fuente
que lo emitió.

## Idempotency y CAS

La clave se resuelve en el scope `(tenantId, operation, idempotencyKey)`:

- `NEW`: se reserva la clave y puede comenzar la operación;
- `REPLAY`: mismo digest, se devuelve el receipt anterior sin otro efecto ni
  evento;
- `CONFLICT`: digest distinto, se rechaza sin mutación;
- `IN_PROGRESS`: una ejecución con el mismo digest mantiene un solo owner.

La tabla de idempotency debe ser durable o el adapter debe anunciar que el
replay entre procesos no está garantizado. No se puede reutilizar una key de
otro tenant, operación o scope.

Un CAS escribe solo si coinciden identity, token/frontera, action digest y,
cuando aplica, fence. Si falla, el efecto y el evento son cero; el resultado es
`CAS_MISMATCH`, se observa la fuente y se vuelve a comprobar. Un read seguido
de un write incondicional no es una implementación de CAS.

## Single-flight y sharing scoped

La clave de `SINGLE_FLIGHT` es el digest canónico de:

```text
(tenant, authorizationScope, source identity, query, validator,
validity policy, required scopes, change set, expected frontier)
```

La proyección canónica usa el dominio `premise-policy-sharing/1` e incluye
explícitamente `(resourceId, incarnationId, versionToken)`. `required scopes`
y `expected frontier` son conjuntos: se eliminan duplicados y se ordenan antes
del digest. Ningún otro array cambia de orden. La clave wire es
`sha256:<64 hex>`. Si query, versión, autorización, policy o change set no se
pueden identificar, la implementación MUST desactivar sharing en vez de crear
una clave parcial.

Solo una llamada es `owner`. Los waiters pueden recibir el resultado del owner
si la clave coincide exactamente; un timeout o error del owner no fabrica un
resultado válido y permite un nuevo owner. Keys distintas pueden validar la
misma fuente físicamente, pero no se fusionan semánticamente.

`SCOPED_SHARING` exige igualdad de tenant, autorización, recurso y encarnación,
scopes, query, validator, policy, change set y frontier. Dos subjects solo
comparten si hay una autorización explícita verificable. Si un dato no puede
compararse, se desactiva sharing y se valida por separado. Sharing reduce
trabajo; no amplía permisos ni cambia una decisión por item.

## Leases fenced

Una lease de trabajo prolongado devuelve `leaseId`, expiración y un fencing
token monotónico. Renovar crea un token mayor. La fuente debe comprobar el
token en cada commit y rechazar un owner antiguo (`FENCING_REPLAY`) después de
expirar, renovar o transferir la lease.

Un owner que despierta tarde puede terminar trabajo local, pero no puede
aplicar un write ni emitir un evento de commit. Sin `FENCED_LEASE` solo se
permite un commit atómico de una sola fase protegido por CAS; un booleano o un
TTL de lock no es fencing.

## Riesgo

El riesgo se refiere al daño de usar una premisa obsoleta:

| Riesgo | Obligaciones mínimas adicionales | Resultado con TTL fallback |
| --- | --- | --- |
| `LOW` | Evidencia verificable, identity y scope. | `USE` antes de expirar; luego `REVALIDATE`. |
| `MEDIUM` | Token/lectura condicional cuando exista; CAS para writes. | Solo lectura informativa; no autoriza write. |
| `HIGH` | Versionado, coherencia causal requerida, CAS, idempotency y receipts cuando apliquen. | No `USE`; `REVALIDATE`/`UNSUPPORTED`. |
| `CRITICAL` | Ninguna propiedad requerida puede ser `UNKNOWN`; ownership usa fence. | `UNSUPPORTED` o `REJECT`. |

Una policy puede ser más estricta. Nunca puede bajar el nivel de riesgo para
hacer que una candidate entre en la frontier.

### Planner ejecutable mínimo

La referencia runtime expone `planPremiseValidation` como función pura. Recibe
operación, riesgo, estado, modo de fuente, capabilities y cobertura causal. Su
salida separa `decision`, método de validación y `guardRequired`. Para un write
`FRESH` y versionado puede ahorrar la lectura previa, pero solo devuelve `USE`
si sigue exigiendo CAS/conditional action e idempotencia; riesgo alto/crítico
también exige frontier completa, y una lease declarada exige fencing. `USE` en
policy nunca significa que el efecto pueda saltarse `premise-guard/1`.

## Frontier segura

La frontier se selecciona después de aplicar gates duros, en este orden:

1. `core-complete`, identity/evidencia/scope verificados y frontera causal
   completa;
2. cero acciones inseguras, cero escapes TOCTOU, y CAS presente para todo
   write;
3. sin batch incompleto, receipt cross-scope, owner fenced ni TTL expirado
   presentado como `USE`;
4. excluir del ranking los costes, tokens o latencias `UNKNOWN`; no son cero;
5. calcular Pareto o lexicográfico solo entre las candidates restantes usando
   lecturas, requests, latencia y coste declarados.

Una frontier vacía es un resultado válido y seguro. La selección nunca puede
eliminar una dependencia crítica, cambiar `REJECT` por `USE`, sustituir CAS por
TTL ni premiar una candidate que oculta una métrica desconocida.
