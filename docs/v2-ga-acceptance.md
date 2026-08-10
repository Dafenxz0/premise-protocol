# PREMiSE v2.0 GA: criterios de aceptación

PREMiSE v2.0 GA no se declara porque el código compile o porque el CI pase. Se declara únicamente cuando existe evidencia reproducible de cada gate de [`spec/ga/acceptance.json`](../spec/ga/acceptance.json).

## Qué significa “GA”

GA significa que una organización puede desplegar PREMiSE con un procedimiento repetible, medirlo, recuperar sus datos y entender sus límites. No significa que el protocolo sea una autoridad universal sobre la verdad ni que sustituya una base de datos, un índice vectorial o un proveedor de modelos.

## Umbrales públicos

| Medida | Umbral mínimo para GA | Cómo se demuestra |
|---|---:|---|
| Exactitud en holdout externo | ≥ 95% | Dataset oculto, hash público y runner independiente |
| Frescura dentro del SLA | ≥ 99% | Mutaciones temporales y trazas por tarea |
| Latencia p95 | ≤ 500 ms | Perfil de referencia declarado |
| Latencia p99 | ≤ 2.000 ms | Misma campaña, sin ocultar outliers |
| Tasa de error | ≤ 0,1% | Carga sostenida y recuperación |
| Disponibilidad | ≥ 99,9% | Soak test con health checks y alertas |
| Coste | ≤ 0,05 USD / 1.000 operaciones | Coste de infraestructura documentado, no una estimación inventada |

Los umbrales son criterios de salida, no resultados actuales. Una cifra de un fixture local nunca se puede presentar como evidencia externa.

En el perfil PostgreSQL a escala, el informe separa las colas por operación:
`retrieve` y `query` mantienen p95 <= 500 ms; `register` usa p95 <= 1.000 ms
porque espera persistencia durable y el evento asociado. Todas exigen p99 <=
2.000 ms, error <= 0,1 % y al menos 100 observaciones. El p95 agregado sigue
siendo <= 500 ms y los umbrales quedan en el artefacto para que el lector pueda
reproducir la decisión.

## Bloqueadores que no se pueden marcar como “cumplidos” por documentación

El expediente GA también debe demostrar, con observaciones de la infraestructura
objetivo y revisión separada, todos estos controles. Son condiciones obligatorias,
no recomendaciones ni defaults del servidor:

| Control | Evidencia mínima que el gate exige | Lo que no cuenta |
|---|---|---|
| Custodia de claves | `security-report.json` con KMS/HSM externo, rotación, revocación, recuperación y mínimos privilegios observados | `KeyRing` en memoria, una variable de entorno o un test de AES/Ed25519 |
| Transporte | TLS impuesto en el perímetro de producción | HTTP local o decir que “TLS lo puede poner el usuario” |
| Identidad y permisos | OIDC o mecanismo equivalente, autorización revisada y aislamiento de tenants observado | Un token estático sin revisión de IAM o un endpoint público |
| Auditoría | Audit log durable, evidencia de integridad y recuperación | Un hash-chain o fichero local sin retención ni restauración probada |
| Revisión independiente | Revisor separado, informe externo con SHA-256, atestación Ed25519 y cero hallazgos críticos/altos abiertos | Autoafirmar `pass` en el mismo repositorio |
| Holdout | `INDEPENDENT_EVIDENCE`, atestación verificada, al menos 200 tareas y umbrales de precisión/frescura cumplidos | `CANDIDATE_EVIDENCE`, fixture local o un holdout de una sola tarea |
| Coste | Facturación del proveedor o telemetría medida, con operaciones, periodo y trazas, dentro del umbral | Modo `modeled`, CPU local o una tarifa sin consumo medido |
| Rollback | Artefacto `passed` con A→B→A, dos identidades de imagen, round-trip de datos y fases observadas | Un script, una imagen construible o un plan escrito |

`node scripts/ga-gate.mjs --strict` aplica estas comprobaciones sobre los
artefactos canónicos. `evidence-checked` significa que el expediente pasó el
contrato estructural y semántico; no es una etiqueta de release ni sustituye la
verificación humana de firmas, digests, permisos, entorno y claims. Si falla
cualquiera de estos controles, el resultado no es elegible para declarar GA.

## Reglas de evidencia

Cada resultado GA debe conservar:

- versión exacta del commit y del dataset;
- hardware, versión de Node, configuración y número de repeticiones;
- trazas crudas, errores y tareas descartadas;
- comparación con al menos un baseline sin PREMiSE;
- reproducción independiente. Una explicación de por qué aún no es posible solo
  puede acompañar a una release candidate, nunca cerrar un gate GA.

Si falta un artefacto, el estado correcto es `candidate` o `blocked`, nunca `GA`. El script `scripts/ga-gate.mjs` comprueba la presencia y la forma de estos artefactos; no convierte automáticamente resultados incompletos en una promesa.

## Proceso de liberación

1. Ejecutar las campañas visibles y generar hashes.
2. Congelar el holdout sin entregarlo al sistema evaluado.
3. Ejecutar persistencia, carga, recuperación y despliegue en una infraestructura declarada.
4. Guardar los artefactos en un directorio de evidencia inmutable.
5. Ejecutar `pnpm ga:gate --strict`.
6. Verificar manualmente KMS/HSM, TLS, OIDC/IAM, aislamiento, auditoría,
   revisión independiente, privacidad, coste y rollback.
7. Etiquetar `v2.0.0` solo si todos los gates están verdes.
