# PREMiSE `premise-policy/1`

La policy decide el presupuesto de coherencia sin alterar la semántica del
core. Puede agrupar trabajo y compartir resultados únicamente dentro de una
clave de alcance idéntica.

## Capabilities

`RESOURCE_IDENTITY`, `INCARNATION_ID`, `VERSION_TOKEN`, `SCOPED_READ`,
`CONDITIONAL_READ`, `CHANGE_SET`, `BATCH_READ`, `SUBSCRIPTIONS`,
`ORDERED_EVENTS`, `TRANSACTION_SNAPSHOT`, `CAUSAL_FRONTIER`, `CAS`,
`CONDITIONAL_ACTION`, `ATOMIC_BATCH`, `IDEMPOTENCY_KEY`, `SINGLE_FLIGHT`,
`SCOPED_SHARING`, `FENCED_LEASE`, `TTL_ONLY`, `UNVERSIONED` y
`FULL_RESOURCE_ONLY`.

Una capability no anunciada no se presume. El fallback debe declarar qué
garantía se pierde.

## Sharing, single-flight y leases

Un resultado de validación solo puede compartirse si coinciden tenant, recurso,
encarnación, scopes, validador, autorización, policy y frontera causal. Una
lease expira y puede ser invalidada por un evento; su fencing token evita que
un propietario anterior escriba después de perderla.

La policy nunca convierte `INVALID` o `UNKNOWN` en `FRESH` ni elimina una hoja
de la frontera crítica calculada por el core.
