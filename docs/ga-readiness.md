# PREMiSE v2.0 GA: auditoría pública de preparación

## Veredicto ejecutivo

PREMiSE v2 es una base técnica seria para construir un producto real: define
un protocolo de validez, conserva procedencia y versión, propaga cambios,
ofrece persistencia, adapters, seguridad, API y herramientas de evaluación.
Eso no equivale todavía a una certificación de producción ni a una solución
universal para cualquier memoria, conector, modelo o contexto.

En la auditoría de la rama `codex/v2-ga-production`, el contrato público de
[`spec/ga/acceptance.json`](../spec/ga/acceptance.json) sigue declarando
`"status": "candidate"`. La decisión es correcta: aún deben cerrarse pruebas
externas e independientes que no se pueden sustituir por implementación,
fixtures o una única ejecución de CI.

La regla sencilla es: **si un gate no tiene evidencia reproducible y revisada,
la release no es GA**.

## Qué se está evaluando

PREMiSE no pretende ser una base de datos vectorial, un sistema de embeddings,
un motor de retrieval, una memoria principal, un dashboard, un servicio cloud ni
una autoridad universal sobre la verdad. El producto aporta una capa más
concreta: ayudar a decidir si una memoria sigue siendo utilizable frente a la
evidencia, la versión y las dependencias que la respaldan.

Por eso las métricas miden propiedades observables del protocolo y del servicio
desplegado, no la verdad semántica de un documento ni la calidad general de un
LLM.

## Criterios públicos de éxito

Los números de esta tabla son **umbrales de salida** definidos en
`spec/ga/acceptance.json`. No son resultados actuales ni promesas comerciales.

| Criterio | Explicación para no expertos | Umbral público | Evidencia que cuenta |
| --- | --- | ---: | --- |
| Precisión | De las tareas del holdout, cuántas respuestas coinciden exactamente con el oracle del evaluador. | ≥ 95% | Holdout oculto, dataset con hash, oracle fuera del candidato, trazas completas, baseline y reproducción independiente. |
| Frescura | De las respuestas utilizables, cuántas usan la versión de la fuente que estaba vigente para esa tarea. | ≥ 99% | Fuentes versionadas y/o mutadas, timestamps/versiones, decisiones por tarea y casos stale/invalid/unknown registrados. |
| Latencia p95 | Tiempo por operación que no supera al 95% de las observaciones; muestra el comportamiento habitual alto. | ≤ 500 ms | Perfil de referencia fijado, red y persistencia incluidas cuando formen parte del servicio, muestras completas y outliers conservados. |
| Latencia p99 | Tiempo que no supera al 99% de las observaciones; hace visibles colas y casos lentos. | ≤ 2.000 ms | La misma campaña que p95, sin reemplazar errores o timeouts por ceros ni ocultar la cola superior. |
| Tasa de error | Proporción de peticiones que fallan, expiran o devuelven un resultado no válido. | ≤ 0,1% | Carga sostenida, logs, códigos de error, timeouts, reintentos y conteo de todas las operaciones intentadas. |
| Disponibilidad | Proporción de servicio operativo durante la ventana acordada, con un denominador explícito. | ≥ 99,9% | Soak suficiente, health/readiness y peticiones reales, alertas, interrupciones registradas y recuperación observada. |
| Coste | Coste atribuible a ejecutar el workload, expresado por 1.000 operaciones. | ≤ 0,05 USD | Medición de infraestructura y servicios realmente usados, periodo, proveedor, región, consumo, almacenamiento, red y reglas de prorrateo documentados. |

### Perfil de latencia de PostgreSQL a escala

El gate agregado conserva el umbral publico de p95 <= 500 ms y p99 <= 2.000
ms. El informe de la campana PostgreSQL tambien exige colas separadas por
operacion, con al menos 100 muestras de cada una:

| Operacion | p95 maximo | Por que |
| --- | ---: | --- |
| `retrieve` | 500 ms | Lectura directa de una memoria persistida. |
| `query` | 500 ms | Consulta lexical sobre el indice FTS persistido. |
| `register` | 1.000 ms | Escritura durable: incluye confirmacion de persistencia y evento. |

El p99 maximo es 2.000 ms y la tasa de error maxima es 0,1 % para todas las
operaciones. Esta diferenciacion no oculta la cola: hace explicito que una
escritura durable tiene un presupuesto distinto, mientras que el resultado
global sigue sujeto al umbral publico de 500 ms.

### Cómo no malinterpretar estos números

La precisión depende de las tareas y del oracle; no es una medida de verdad
universal. La frescura depende de cómo se observa la fuente y de su SLA. p95 y
p99 no son un SLA si solo se midieron en una máquina local o sobre una función
en memoria. Disponibilidad necesita declarar si se mide por tiempo, por
petición o por health check; un único ping verde no representa un servicio.
Coste necesita un workload y un denominador: una estimación de CPU local o el
coste de una descarga aislada no es una factura de producción.

## Qué evidencia es válida

### Evaluación externa y ciega

Debe existir un holdout que el equipo y el sistema evaluado no hayan usado para
ajustar reglas, prompts, thresholds o código. El runner recibe la tarea y la
fuente permitida, pero no el split, snapshot, oracle, respuesta esperada ni
corrección. El manifest publica hashes y metadatos suficientes para verificar
qué se ejecutó sin revelar el contenido antes de tiempo.

La evidencia mínima es `external-holdout.json`, `dataset-manifest.json` y las
trazas crudas asociadas. Una ejecución sobre fuentes públicas versionadas es
útil como control reproducible; no es por sí sola un holdout independiente.

### Postgres, GitHub y otros conectores

Un conector real debe ejecutarse contra el servicio real y con su contrato de
permisos, errores, rate limits, timeouts y cambios de versión. Para PostgreSQL
eso incluye migraciones, transacciones, aislamiento por tenant, backup y
restore verificado. Para GitHub incluye autenticación de prueba con permisos
mínimos, modo de solo lectura cuando corresponda, rate limits, respuestas
condicionales y una campaña que observe una fuente cambiada; leer dos veces el
mismo snapshot no prueba recuperación ante mutación.

Los mocks, test doubles, fixtures locales y un adapter que solo compile no
cuentan como integración real. La existencia de un adapter GitHub o PostgreSQL
no acredita disponibilidad de GitHub, PostgreSQL ni de “otros conectores” que
no se hayan probado en una campaña propia.

### Carga, recuperación y contexto grande

La campaña debe fijar el perfil: número de memorias, tamaño de payload, tenants,
concurrencia, persistencia, red, hardware, límites de memoria y versión de
Node. Debe conservar throughput, p50/p95/p99, memoria, backpressure, errores,
aislamiento, duplicados, reinicios, corrupción/truncación y recuperación desde
snapshot o backup.

Un millón de registros sintéticos demuestra el comportamiento de ese workload;
no demuestra que cualquier contexto de un millón de tokens, payload real,
retrieval semántico o proveedor externo tenga la misma capacidad. Los
resultados de contexto gigante deben declarar qué parte es preparación, qué
parte es consulta y qué parte pertenece al proveedor de embeddings o modelo.

### Soak y disponibilidad

El soak debe ejecutarse durante una ventana y volumen suficientemente grandes
para que el umbral de 99,9% sea significativo. La campaña debe predeclarar
duración, frecuencia, concurrencia, número total de operaciones, definición de
éxito, errores tolerables, ventanas de mantenimiento y cómo se cuentan los
reintentos. También debe capturar alertas, degradaciones, reinicios y tiempo de
recuperación.

Una carga CI acotada, un smoke test, una prueba de readiness o un benchmark que
termina en segundos no certifican disponibilidad anual. Una prueba de soak en
una única máquina tampoco prueba disponibilidad de todos los despliegues; la
infraestructura objetivo y, cuando se publique una promesa general, una
reproducción independiente deben quedar identificadas.

### Rollback observado

La documentación y los scripts de rollback son un procedimiento, no una
observación. El artefacto `rollback-report.json` debe mostrar una secuencia real
con dos imágenes o releases inmutables: desplegar A, actualizar a B, escribir y
leer datos, cambiar de vuelta al digest de A, comprobar readiness y smoke,
verificar compatibilidad del esquema y conservar el backup. Deben quedar
logs/timestamps, resultado de las comprobaciones y cualquier pérdida o
degradación. El rollback no puede asumir que una migración destructiva se
deshace sola.

### Seguridad y gestión de claves

Las firmas Ed25519, HMAC, AES-GCM, AAD, ACL, replay guard, redacción y cadena
de auditoría son primitivas y controles que pueden probarse en el repositorio.
No son por sí mismas una integración KMS/HSM ni una garantía de seguridad
operativa.

Para GA hay que documentar y observar cómo se generan, almacenan, resuelven,
rotan, retiran y auditan las claves; qué identidad puede usarlas; cómo se
separan tenants y réplicas; cómo se persiste el replay guard; cómo se protege
el audit log frente a borrado; y cómo se recupera un servicio sin exponer
secretos. El threat model debe enumerar amenazas, límites, supuestos,
responsables y controles verificables. Un `KeyRing` en memoria o un hash-chain
en un archivo local no sustituye esas garantías.

### Despliegue, observabilidad y API

La evidencia operativa debe poder reconstruir la imagen desde un commit, iniciar
el servicio con configuración segura, ejecutar migraciones, comprobar readiness,
exponer métricas, activar alertas, hacer backup/restore y realizar rollback.
Las métricas sin logs correlacionables, dashboards sin alertas conectadas o un
Compose local sin secretos reales son materiales de operación y desarrollo,
no una prueba de disponibilidad de producción.

El SDK y OpenAPI deben probar compatibilidad de contrato, errores, paginación,
timeouts, reintentos e idempotencia. Eso demuestra una interfaz estable; no
demuestra que cada conector o despliegue detrás de ella esté disponible.

## Qué no cuenta como evidencia GA

- Pasar `pnpm test`, `pnpm build` o un workflow de CI sin conservar la campaña
  y sin reproducir los gates que dependen de servicios externos.
- Fixtures, datos sintéticos, test doubles o snapshots locales presentados como
  benchmark externo o prueba de un usuario real.
- Una única máquina, una única semilla, una única ejecución o solo la media,
  especialmente si no se publican p95, p99, errores y outliers.
- Un benchmark live de GitHub en solo lectura sin mutación observada, sin
  runner independiente o sin separación del holdout.
- Un resultado con el oracle, la respuesta dorada o el split de evaluación
  entregado al candidato.
- Tests de primitivas criptográficas usados como prueba de KMS/HSM, identidad,
  compliance, secreto bien custodiado o auditoría WORM.
- Un script de backup/rollback no ejecutado, un restore que no verifica datos o
  una imagen anterior no identificada por digest.
- Un cálculo de coste basado solo en CPU local, una tarifa no documentada o
  operaciones que omiten red, base de datos, almacenamiento, egress, tokens o
  reintentos que el producto realmente use.
- Eliminar fallos, timeouts, tareas descartadas o periodos de degradación del
  informe para mejorar un porcentaje.

## Bloqueos actuales para declarar GA

La siguiente matriz no cambia `acceptance.json`; hace públicos los puntos que
deben cerrarse antes de editar una release a GA.

| Bloqueo | Situación verificable en el repositorio | Qué falta para cerrarlo |
| --- | --- | --- |
| Holdout independiente | Hay harnesses y datasets versionados, además de campañas live separadas de fixtures. Eso no equivale todavía a un holdout oculto ejecutado por un tercero o runner independiente. | Custodio independiente, corpus oculto, hash público, oracle separado, trazas completas, varias repeticiones/semillas y reproducción independiente sin tuning contra el holdout. |
| Soak y disponibilidad | Las cargas acotadas y escenarios de recuperación prueban invariantes y un workload finito. No certifican 99,9% de disponibilidad sostenida. | Campaña de soak con duración/volumen/denominador predefinidos, health y operaciones reales, alertas, fallos inyectados, recuperación y resultado reproducido en la infraestructura declarada. |
| Rollback observado | Existen instrucciones y scripts para cambiar a una imagen anterior; un procedimiento escrito no es un registro de ejecución. | Despliegue A→B→A con digests inmutables, datos escritos, migraciones compatibles, readiness/smoke, backup y logs/resultado de la secuencia. |
| KMS/HSM y custodia | `security-core` implementa primitivas y controles en proceso, pero documenta explícitamente que no es KMS, HSM, almacén durable ni proveedor de identidad. | Integración o control operativo equivalente con gestión de claves, permisos mínimos, rotación/retiro, recuperación, separación por tenant/réplica y auditoría durable revisada. |
| Conectores reales | Hay caminos para PostgreSQL, GitHub y webhook, y suites de evaluación. La presencia del código o un read-only live run no garantiza todos los casos operativos ni conectores adicionales. | Campañas por conector con credenciales/permisos mínimos, rate limits, errores, cambios, backups, recuperación y soporte declarado; no anunciar conectores no probados. |
| Coste observado | El umbral público está definido, pero un coste estimado de benchmark no es una factura ni un coste de servicio multi-tenant. | Workload fijado, medición de recursos y facturación del proveedor, periodo, región, almacenamiento, red, reintentos y denominador por 1.000 operaciones. |
| Revisión operativa y seguridad | Hay documentación, controles y tests locales; la implementación no reemplaza la revisión independiente del threat model, IAM y operación. | Revisión por persona/equipo separado, hallazgos y remediación, permisos de producción, gestión de secretos, retención, alertas y runbooks probados. |
| Disponibilidad de producción | Compose y el workflow ofrecen un entorno reproducible con forma de producción. No prueban por sí solos SLA, SLO ni capacidad de un proveedor externo. | Entorno objetivo con métricas, alertas, backups, on-call/respuesta, recuperación y evidencias firmadas durante la ventana de aceptación. |

Hasta cerrar estos puntos, la descripción correcta es **release candidate o
producto en validación**, no “PREMiSE v2.0 GA listo para cualquier producción”.

## Matriz de claims permitidos y no permitidos

| Claim público | Permitido con la evidencia adecuada | No permitido todavía / forma incorrecta |
| --- | --- | --- |
| “PREMiSE implementa el protocolo v2 y sus estados de validez.” | Sí, si se cita la spec, los schemas y la conformance suite. | “El protocolo garantiza que el contenido es verdadero.” |
| “En el dataset X, commit Y, obtuvo Z.” | Sí, solo con el manifest, hashes, trazas y configuración exactos; se limita a ese workload. | “Tiene Z% de precisión en el mundo real” sin holdout y reproducción independiente. |
| “El adapter GitHub puede leer este endpoint en modo declarado.” | Sí, con credenciales, permisos, versión, errores y traza de esa campaña. | “GitHub estará siempre disponible”, “detecta cualquier cambio” o “todos los conectores están listos”. |
| “El servicio pasó una integración PostgreSQL.” | Sí, si se identifica versión, esquema, migraciones, aislamiento y resultado de backup/restore. | “PostgreSQL ofrece el SLA de PREMiSE” o “la base local demuestra producción”. |
| “Las primitivas rechazan payloads manipulados en las pruebas.” | Sí, como claim acotado a los vectores y API probados. | “PREMiSE es seguro/compliant” sin threat model, identidad, KMS/HSM y revisión operativa. |
| “La campaña observó p95/p99 y coste concretos.” | Sí, con perfil, denominador, periodo, host/proveedor y trazas. | Convertir una medición local, estimación o promedio en SLA o precio universal. |
| “El rollback fue probado.” | Solo después de publicar `rollback-report.json` de una secuencia A→B→A observada. | Citar `rollback.sh`, un plan escrito o una imagen construible como si fuese una prueba. |
| “La API/SDK es compatible.” | Sí, para la versión y política de compatibilidad documentadas, con tests de contrato. | Prometer compatibilidad indefinida o disponibilidad de los servicios detrás. |
| “PREMiSE v2.0 GA está listo.” | Solo cuando todos los gates de `acceptance.json` estén verdes, revisados y reproducidos. | Antes de cerrar holdout, soak, rollback, KMS/HSM, coste y conectores declarados. |

## Paquete de publicación recomendado

Antes de una etiqueta GA, el expediente debe contener los artefactos listados
en [`spec/ga/README.md`](../spec/ga/README.md), sus SHA-256, el commit de la
release, logs y trazas sin resumir, la configuración exacta, la revisión del
threat model, la política de compatibilidad, el runbook de operaciones y una
lista explícita de límites conocidos. Los artefactos públicos deben estar
separados de secretos y datos personales, pero no de forma que desaparezcan
fallos relevantes.

La etiqueta `evidence-checked` solo indica que se encontraron artefactos. La
decisión GA exige además leerlos, verificar sus firmas/digests, repetir lo que
requiera independencia y comprobar que los claims publicados no exceden lo
que los datos permiten afirmar.

Desde esta rama, el gate también comprueba el contenido mínimo de los claims
críticos; no acepta un JSON con `schema`, `commit` y `trace` como sustituto de
una campaña pasada. En concreto:

- `security-report.json` debe declarar `status: "pass"`, KMS/HSM externo,
  rotación, revocación, recuperación, mínimos privilegios, TLS impuesto,
  OIDC/equivalente, autorización, aislamiento de tenants y auditoría durable.
  Debe enlazar un informe de revisión separado por SHA-256, con atestación
  Ed25519, cero hallazgos críticos/altos abiertos y `claims.eligibleForGa: true`.
- `threat-model.md` debe explicar explícitamente esos límites y dejar claro que
  PREMiSE no es un KMS/HSM, proveedor de identidad ni garantía universal de
  seguridad o compliance.
- `external-holdout.json` debe ser `INDEPENDENT_EVIDENCE`, tener atestación
  verificada, al menos 200 tareas y cumplir precisión/frescura; un booleano
  `independent` aislado no es suficiente.
- `cost-report.json`, `soak-availability.json` y `rollback-report.json` deben
  declarar respectivamente medición real y umbral, soak de duración/volumen
  completos, y secuencia A→B→A observada con datos preservados.

Estas comprobaciones son un cierre de claims, no una auditoría mágica: el script
valida la forma, los vínculos y los resultados declarados, pero una persona
separada debe confirmar la identidad del revisor, las firmas, los permisos, la
infraestructura, la factura y la ausencia de tuning contra el holdout. Si la
verificación humana no existe, el estado público sigue siendo `candidate`.

### Expediente de la campana manual

El workflow publica los nombres canonicos `load-full.json`,
`postgres-scale.json`, `recovery-report.json` y `soak-availability.json`.
Estos nombres deben coincidir con `spec/ga/acceptance.json`; un nombre de job o
un `results-full.json` no sustituye al artefacto publico canonico.

Los informes deben conservar evidencia raw. La campana PostgreSQL conserva
`postgres-scale-traces.jsonl` y `recovery-report-traces.jsonl`, ademas de sus
logs de ejecucion; el soak conserva el JSON del diagnostico, la salida raw del
runner y los logs del stack. Subir un directorio que solo contiene un log de
preparacion no convierte un job fallido o incompleto en evidencia GA.

La inspeccion exige `schema`, `commit`, `generatedAt`, `source` y `trace`. Si
aparece `format`, debe ser igual a `schema`; `commit` puede ser el SHA completo
o un objeto con `value` igual a ese SHA. Esto corrige la forma del contrato sin
cambiar umbrales ni sustituir una revision independiente.

En una ejecucion manual, cualquier job de certificacion con resultado
`skipped`, `failure`, `cancelled` o sin resultado bloquea GA. La decision final
debe ejecutarse aunque haya dependencias omitidas y exigir `success` en los
diez resultados: seguridad, carga CI, carga de un millon, escala PostgreSQL,
GitHub, holdout, integracion, soak, coste y rollback.

## Glosario breve

- **Holdout**: conjunto de tareas reservado hasta la evaluación final; sirve
  para comprobar que el sistema no fue ajustado a las respuestas.
- **Soak**: ejecución sostenida para descubrir degradación, fugas, reinicios y
  fallos que una prueba corta no ve.
- **Rollback**: volver a una versión anterior identificada por digest sin
  perder ni corromper los datos compatibles.
- **KMS/HSM**: servicios o dispositivos especializados para custodiar y usar
  claves criptográficas con controles operativos; una librería en memoria no
  los sustituye.
- **p95/p99**: percentiles de latencia; muestran la cola lenta, no solo el
  promedio.
