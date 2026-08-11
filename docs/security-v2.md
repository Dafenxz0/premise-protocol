# Seguridad de PREMiSE v2: estado verificable y límites

Este documento separa lo que el repositorio puede demostrar de lo que solo
puede demostrarse en una instalación real. Es una guía de despliegue seguro,
no una certificación ni una afirmación de que PREMiSE sea una autoridad
universal sobre la verdad.

## Controles demostrables en el código

| Área | Garantía local | Evidencia | Límite explícito |
| --- | --- | --- | --- |
| API | En cualquier entorno cuyo nombre no sea exactamente `development`, la ausencia de token o un token inválido bloquean el arranque o la petición. La comparación usa un digest de longitud fija y `timingSafeEqual`. | `ops/auth.mjs`, `ops/auth.test.mjs`, `ops/server.routes.test.mjs` | El token estático no sustituye OIDC, mTLS, rotación, revocación ni una revisión IAM. |
| Métricas | Usa un bearer separado del token de API; no se acepta el token de API para `/metrics`. | `ops/server.mjs`, `ops/server.routes.test.mjs` | TLS y la política de exposición del endpoint pertenecen al perímetro de despliegue. |
| Healthcheck | En entornos protegidos, `/readyz` solo permite bypass desde una dirección TCP loopback; no confía en headers enviados por el cliente. | `ops/auth.mjs`, `ops/auth.test.mjs` | El modo `development` puede quedar abierto para smoke tests locales; el endpoint protegido solo debe exponerse a la red de salud del runtime. |
| Envelopes | El runtime puede rechazar sobres sin firma, alterados, con clave desconocida o replayados mediante Ed25519. | `packages/protocol-types`, `packages/runtime-core` | El replay store por defecto es local al proceso y acotado. |
| Claves de firma | El entrypoint valida al arrancar que las claves del fichero sean públicas Ed25519 y rechaza material privado. | `ops/server.mjs` | Un fichero montado no es KMS/HSM ni demuestra rotación, revocación o recuperación. |
| Tenant | El servidor fija el tenant configurado, desactiva `x-premise-tenant`/`x-premise-subject` y el runtime comprueba la frontera de tenant. | `ops/server.mjs`, `packages/premise-server`, `packages/runtime-core` | Debe validarse además con el rol, RLS, grants y datos de PostgreSQL reales. |
| PostgreSQL | El arranque rechaza un rol `SUPERUSER` o `BYPASSRLS` para el servicio. | `ops/auth.mjs`, integración PostgreSQL | No demuestra por sí solo que todos los grants, políticas RLS, backups y operadores estén aislados. |

## Fallo cerrado que aplica el servidor

El servidor HTTP incluido no activa firmas en `staging`, `production` ni en
otro entorno protegido aunque se proporcione `PREMISE_SIGNATURE_KEYS_FILE`.
La razón es deliberada: su replay store actual es `MemoryV2SignatureReplayStore`
y perdería estado al reiniciar o entre réplicas. Para habilitar esa capacidad
en producción hay que integrar primero un replay store compartido, durable y
atómico en el proceso que construye `PremiseRuntime`; no basta con subir el
fichero de claves.

Del mismo modo, `PREMISE_ENV=prod`, `PREMISE_ENV=staging ` o cualquier valor no
reconocido no se trata como desarrollo: exige autenticación. Solo el valor
`development`, ignorando mayúsculas y espacios exteriores, habilita el modo
local abierto. La configuración debe ser explícita y los errores de nombre no
deben abrir el servicio.

## Controles que todavía requieren infraestructura externa

PREMiSE no declara cumplidos estos controles solo por tener primitivas o
tests locales:

- TLS/mTLS impuesto en el perímetro y validación de certificados.
- OIDC o un proveedor equivalente, scopes/roles, mínimos privilegios,
  rotación, revocación y recuperación de identidades.
- KMS/HSM, envoltura de claves, separación de funciones y rotación observada.
- Cifrado de datos en reposo y de backups, gestión de claves y borrado seguro.
- Audit log append-only durable, con redacción, retención, almacenamiento
  WORM/inmutable, permisos separados y restauración probada.
- RLS y grants verificados contra PostgreSQL real con cuentas de aplicación y
  migración separadas, incluidos intentos cross-tenant.
- Aislamiento de red, filesystem, contenedor, secretos y límites de recursos.
- Alertas, respuesta a incidentes, parcheado, escaneo de imágenes/SBOM y
  revisión independiente.

## Gate mínimo antes de llamar GA a una instalación

La instalación debe aportar evidencia fechada y reproducible, asociada al
commit y al artefacto desplegado, de:

1. autenticación real en todas las rutas, incluyendo requests sin token,
   tokens caducados/revocados y acceso a métricas;
2. firma, rotación/revocación y replay con varias réplicas y después de
   reinicios;
3. intentos de leer/escribir datos de otro tenant, con roles PostgreSQL sin
   privilegios elevados;
4. auditoría durable y recuperación desde backup sin perder integridad;
5. TLS, permisos, alertas, backup, rollback y restauración en el entorno
   operativo real;
6. revisión independiente que no sea generada por el candidato y que enlace
   sus hashes de evidencia;
7. benchmarks externos ciegos con tareas reales, latencia, frescura, coste,
   disponibilidad y límites de carga publicados.

Si falta una de estas pruebas, el resultado debe etiquetarse como candidato,
staging o evidencia local, nunca como “100% seguro” o “GA universal”.
