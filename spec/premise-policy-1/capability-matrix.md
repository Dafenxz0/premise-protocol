# Matriz de capabilities de `premise-policy/1`

Esta matriz complementa el contrato cerrado de
[`contract.schema.json`](./contract.schema.json). Una capability no es una
promesa: el adapter debe anunciarla y adjuntar evidencia como propiedades
verificables. Si una capability no está anunciada, se obtiene
`UNSUPPORTED` cuando la operación la necesita; no se presume ni se simula.

Los nombres son los identificadores estables del perfil. `native` significa que
el adapter ejecuta la garantía; `delegated`, que la ejecuta una fuente/store
identificado; `fallback`, que solo ofrece la garantía débil descrita en la
última columna.

| ID | Clase | Garantía | Propiedad que debe poder verificarse | Ausencia/fallo | Fallback permitido |
| --- | --- | --- | --- | --- | --- |
| `RESOURCE_IDENTITY` | core | Aísla tenant y recurso lógico. | `identity-bound`, `tenant-isolated` | `UNSUPPORTED` o `REJECT`; nunca downgrade. | Ninguno. |
| `INCARNATION_ID` | core | Distingue delete/recreate y evita ABA aunque se repita una revisión. | `incarnation-unique` | `REJECT` una observación de otra encarnación. | Ninguno. |
| `VERSION_TOKEN` | core | Conserva el token opaco de la observación que se comprobó. | `version-bound` | `REVALIDATE`; no se ordena ni se inventa el token. | `TTL_ONLY` solo con riesgo compatible. |
| `EVIDENCE_PROPERTIES` | core | Expresa claims por predicado, sujeto, verificador, instante y digest de artefacto. | `evidence-verified` | `UNKNOWN` no es evidencia; `REVALIDATE` o `REJECT`. | Ninguno. |
| `SCOPED_READ` | safety | Lee solo dentro de tenant, autorización, scopes, validador y frontera declarados. | `scope-matched` | `REJECT` por cruce o scope incompleto. | Leer por item, sin compartir. |
| `CONDITIONAL_READ` | safety | Compara identidad y token (`MATCH`, `NOT_MODIFIED`, `MISMATCH`, `GONE` o `UNKNOWN`). | `conditional-read-bound` | Una lectura incondicional no satisface la policy. | `TTL_ONLY` no autoriza writes. |
| `CHANGE_SET` | coherence | Trata los miembros requeridos, su digest y su frontera como una unidad lógica. | `change-set-complete` | `REVALIDATE` o `REJECT`; nunca éxito parcial. | Validación por miembro solo si el core no exige atomicidad. |
| `TRANSACTION_SNAPSHOT` | coherence | Captura una vista inmutable con identity, event head y timestamp. | `snapshot-coherent` | No se afirma coherencia causal. | Lectura individual de bajo riesgo, con esa pérdida declarada. |
| `CAUSAL_FRONTIER` | coherence | Conserva todas las hojas necesarias para reparar el slice solicitado. | `frontier-complete` | `REVALIDATE`; no se puede quitar una dependencia crítica. | Ninguno. |
| `BATCH_READ` | optimization | Agrupa lecturas sin perder el resultado y receipt de cada item. | `batch-attributed` | Fallback por item, sujeto a los mismos gates. | Ninguno que oculte items ausentes. |
| `ATOMIC_BATCH` | safety | Declara y cumple all-or-nothing cuando el core lo requiere. | `batch-atomic` | `UNSUPPORTED`; un batch parcial no es atómico. | `BATCH_READ` solo para lecturas sin efecto. |
| `SUBSCRIPTIONS` | optimization | Recibe cambios con identity, scopes, versión y event id verificables. | `event-source-bound` | Poll/revalidate; no se presume frescura. | TTL explícito. |
| `ORDERED_EVENTS` | audit | Mantiene eventos append-only, ordered y scoped; un rechazo emite cero. | `event-ordered`, `event-scoped` | `UNSUPPORTED` si se exige auditabilidad/receipt. | Ninguno para ese requisito. |
| `CAS` | safety | El write compara identity, token/frontier y no aplica efectos en mismatch. | `cas-accepted` o `cas-rejected-without-effect` | Toda acción con efecto se bloquea. | Ninguno; read-then-write no es CAS. |
| `CONDITIONAL_ACTION` | safety | El guard y el adapter confirman atómicamente la condición del write. | `conditional-commit` | `UNSUPPORTED` o `REJECT`; no se afirma protección TOCTOU. | Ninguno. |
| `IDEMPOTENCY_KEY` | safety | Scopea key+request digest y devuelve el mismo receipt en replay. | `replay-stable`, `conflict-rejected` | No se reintenta un write mutante. | Ninguno para retries. |
| `TTL_ONLY` | fallback | Usa una ventana finita cuando no hay versión condicional. | `ttl-bounded`, `clock-observed` | Tras expirar: `REVALIDATE`; sin TTL: `UNSUPPORTED`. | Es el fallback y no reemplaza CAS. |
| `UNVERSIONED` | fallback | Declara que la fuente no ofrece token; conserva esa carencia. | `version-unknown` | No puede producir `USE` en riesgo alto/crítico. | `TTL_ONLY` acotado o `REJECT`. |
| `SINGLE_FLIGHT` | optimization | Una sola validación es owner por clave exacta; waiters comparten su receipt. | `single-flight-one-owner` | Duplicar validaciones es correcto pero menos eficiente. | Nunca compartir entre claves distintas. |
| `SCOPED_SHARING` | optimization | Reutiliza una observación solo con igualdad de tenant, auth, source, query, policy y frontier. | `sharing-scope-equal` | Validación separada; cruce = `SCOPE_MISMATCH`. | `sharing: none`. |
| `FENCED_LEASE` | safety | Cada commit incluye un fence monotónico; un owner antiguo no puede escribir. | `lease-fenced`, `stale-owner-rejected` | No se permite commit bajo ownership ambiguo. | Single-shot CAS si el core lo permite. |

## Requisitos no eliminables

Todas las operaciones necesitan `RESOURCE_IDENTITY`,
`EVIDENCE_PROPERTIES`, `SCOPED_READ`, decisión del core y fail-closed. Una
operación con efecto necesita además `CAS` o `CONDITIONAL_ACTION`; una
operación reintentable necesita `IDEMPOTENCY_KEY`; un owner que puede perder el
turno necesita `FENCED_LEASE`.

`BATCH_READ`, `TRANSACTION_SNAPSHOT`, `SINGLE_FLIGHT` y `SCOPED_SHARING` son
optimizaciones: pueden ahorrar trabajo, pero no cambian una decisión por item.
`TTL_ONLY` y `UNVERSIONED` son fallbacks declarados: no sustituyen identidad,
evidencia, coherencia, CAS o guard.

Una selección de frontier filtra primero estas obligaciones y solo después
compara peticiones, lecturas, latencia o coste. Un candidato barato que omite
un requisito del core queda fuera de la frontier; no puede ganar por ser
dominado en una métrica que oculta seguridad.
