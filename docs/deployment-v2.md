# PREMiSE v2: guía de despliegue y fiabilidad

Esta guía explica cómo operar PREMiSE v2 con Docker Compose, PostgreSQL y
Prometheus. Está escrita para que una persona que no mantenga el código pueda
hacer un despliegue controlado, comprobar si el servicio está sano y recuperar
los datos sin confundir una prueba local con una garantía de producción.

## Qué cubre y qué no cubre

La configuración de `deploy/` proporciona:

- una imagen de aplicación ejecutada como usuario sin privilegios, sin
  capacidades Linux y con el sistema de archivos raíz en solo lectura;
- PostgreSQL 16 con escrituras durables, migraciones separadas y una cuenta de
  aplicación `NOSUPERUSER NOBYPASSRLS` protegida por RLS;
- `/health` para salud funcional, `/readyz` para readiness con PostgreSQL y
  `/metrics` protegido con un token de métricas distinto;
- backups NDJSON atómicos, con checksum, orden, conteos y verificación completa;
- restore transaccional, preflight del backup antes de borrar datos y una
  herramienta de rollback que comprueba la imagen que realmente arrancó;
- alertas Prometheus para latencia, errores, persistencia, backpressure y
  pérdida de scraping.

No incluye ni simula un proveedor cloud, KMS/HSM, rotación automática de
claves, cifrado de backups, almacenamiento WORM, TLS público, OIDC, replicación
multi-región, disponibilidad contractual ni un servicio de archivado externo.
Esas piezas deben ser proporcionadas y auditadas por el entorno de despliegue.
Un resultado verde de `preflight` solo demuestra que la configuración local es
coherente; no demuestra que el servicio tenga disponibilidad, coste o SLO de
producción.

## Arquitectura operativa

| Pieza | Responsabilidad | Exposición por defecto |
| --- | --- | --- |
| `premise` | API PREMiSE y persistencia durable | `127.0.0.1:3000` |
| `postgres` | Estado durable de la aplicación | Solo red interna Compose |
| `migrate` | Aplica migraciones bajo la cuenta propietaria | Trabajo de una sola ejecución |
| `prometheus` | Scraping y reglas de alerta | `127.0.0.1:9090` |
| `otel-collector` | Recibe/exporta métricas OTLP | Puertos locales para desarrollo |
| `backup` | Trabajo manual bajo el perfil `ops` | No arranca por defecto |

En producción, el endpoint HTTP debe quedar detrás de un reverse proxy o un
balanceador que aporte TLS, límites de red, autenticación corporativa y
registro de acceso. El Compose base no declara que `127.0.0.1` sea una frontera
de seguridad suficiente para todos los entornos.

## 1. Preparar una configuración reproducible

Usa la plantilla adecuada y guarda el archivo real fuera del repositorio:

```text
deploy/config/development.env.example  -> entorno local
deploy/config/staging.env.example      -> staging
deploy/config/production.env.example   -> producción
```

En staging y producción, estos valores son obligatorios:

- `PREMISE_IMAGE`;
- `PREMISE_POSTGRES_IMAGE`;
- `PREMISE_PROMETHEUS_IMAGE`;
- `PREMISE_OTEL_IMAGE`;
- `PREMISE_NODE_BUILD_IMAGE` y `PREMISE_NODE_RUNTIME_IMAGE` si se construye la
  imagen en el entorno de despliegue;
- `DATABASE_URL` para la cuenta de aplicación;
- `MIGRATIONS_DATABASE_URL` para la cuenta propietaria/migradora;
- `PREMISE_API_TOKEN`, `PREMISE_METRICS_TOKEN` y el archivo fuente del secreto
  `PREMISE_METRICS_TOKEN_FILE`.

Las imágenes deben usar una referencia inmutable con digest:

```text
registry.example/premise-v2@sha256:<64-hex>
```

Los tags `latest`, `stable`, `current`, `previous` y `local`, además de los
valores `local-only`, `not-for-production` y `__INJECT_...__`, son únicamente
para desarrollo o plantillas. El preflight los rechaza cuando el entorno es
`staging` o `production`.

Ejecuta la comprobación antes de llamar a Compose:

```bash
node deploy/preflight.mjs --env-file .env.production
docker compose --env-file .env.production -f deploy/docker-compose.yml config --quiet
```

En PowerShell:

```powershell
node deploy/preflight.mjs --env-file .env.production
docker compose --env-file .env.production -f deploy/docker-compose.yml config --quiet
```

Si falla, no continúes con `up`. El preflight no realiza llamadas a cloud ni
intenta comprobar servicios que no puede ver; esa limitación es deliberada.

### Firmas de envelopes

Para staging y producción se configura:

```text
PREMISE_REQUIRE_SIGNED_ENVELOPES=1
PREMISE_SIGNATURE_KEYS_FILE=/run/secrets/premise_signature_public_keys.json
```

El archivo debe ser montado por el orquestador o por un overlay de Compose. El
repositorio solo verifica firmas Ed25519 contra las claves públicas que recibe;
no guarda claves privadas ni implementa KMS/HSM, rotación o revocación remota.
No se debe convertir el archivo de ejemplo en una clave de producción.

## 2. Arranque y comprobaciones

El arranque aplica esta secuencia:

```text
PostgreSQL sano -> db-roles -> migrate -> premise ready -> Prometheus/OTel
```

Arranque controlado:

```bash
docker compose --env-file .env.production -f deploy/docker-compose.yml up -d
```

Comprueba readiness y salud desde el contenedor de la API. `/readyz` consulta
`SELECT 1` y refleja el estado del store; devuelve `503` si PostgreSQL no está
disponible. `/health` comprueba la respuesta funcional de la API, pero por sí
solo no sustituye a readiness.

```bash
docker compose --env-file .env.production -f deploy/docker-compose.yml \
  exec -T premise node /app/ops/healthcheck.mjs
```

La healthcheck del contenedor usa `/readyz`. Las sondas externas deben enviar
el bearer de operaciones cuando no procedan de loopback:

```text
GET /readyz  -> 200 y {"ok":true,"ready":true}
GET /health  -> 200 y {"ok":true}
GET /metrics -> 200 con el bearer de métricas dedicado
```

No uses el token de métricas para la API ni el token de la API para Prometheus.

## 3. Métricas y alertas

Prometheus consulta `/metrics` con el secreto montado en
`/run/secrets/premise_metrics_token`. Las reglas de
`deploy/alert-rules.yml` cubren:

- p95 por ruta por encima de 500 ms y p99 por encima de 2 s;
- respuestas 5xx y 4xx por encima de los umbrales definidos;
- frescura degradada o memorias inválidas;
- store no listo;
- fallos de persistencia;
- cola de escrituras por encima del 80 % o 95 %;
- pérdida de scraping de PREMiSE o del collector.

La ausencia de un scrape no es una garantía de que Prometheus esté operativo.
El entorno debe tener una supervisión externa de Prometheus y del host. Las
alertas tampoco miden por sí solas backup freshness, coste ni disponibilidad
multi-región; esas señales deben añadirse en el sistema real que las posee.

Ante `PremisePersistenceFailures` o `PremiseWriteQueueSaturated`:

1. proteger el tráfico de escritura y conservar los logs;
2. comprobar `/readyz`, `premise_store_ready` y el estado de PostgreSQL;
3. no borrar el volumen ni reiniciar con `down -v`;
4. crear un backup verificable cuando el store vuelva a estar estable;
5. abrir un incidente si el error budget o la integridad de los datos están en
   riesgo.

## 4. Backup verificable

El backup es por tenant y se escribe primero en un archivo temporal con modo
`0600`; solo se renombra al destino después de cerrar, sincronizar y comprobar
el stream. El formato NDJSON contiene cabecera, entradas ordenadas y footer con
conteos y SHA-256.

El perfil de operaciones no arranca automáticamente:

```bash
mkdir -p .local/backups
docker compose --env-file .env.production -f deploy/docker-compose.yml \
  --profile ops run --rm backup
```

`ops/backup.mjs` vuelve a leer el archivo completo antes de imprimir `verified:
true`. Para verificar una copia trasladada sin tocar PostgreSQL:

```bash
docker compose --env-file .env.production -f deploy/docker-compose.yml \
  --profile ops run --rm \
  -e BACKUP_FILE=/backup/premise-v2-latest.ndjson \
  backup node /app/ops/backup-verify.mjs
```

El resultado debe contener `ok: true`, `verified: true`, conteos y un SHA-256.
Guarda ese digest junto con el artefacto en el sistema externo de backups.
Este repositorio no cifra ni replica el archivo: el destino externo debe
aportar cifrado en reposo, retención, control de acceso, inmutabilidad/WORM y
pruebas periódicas de recuperación.

## 5. Restore y prueba de recuperación

`ops/restore-verify.mjs` crea tablas temporales con un prefijo aleatorio,
restaura dentro de una transacción, recalcula los conteos y el digest, y elimina
las tablas de prueba al terminar. Es la primera opción para una prueba de
recuperación sin reemplazar el tenant operativo:

```bash
docker compose --env-file .env.production -f deploy/docker-compose.yml \
  --profile ops run --rm \
  -e BACKUP_FILE=/backup/premise-v2-latest.ndjson \
  backup node /app/ops/restore-verify.mjs
```

Para un restore destructivo se exige una confirmación explícita y se recomienda
fijar el digest del artefacto antes de comenzar:

```bash
docker compose --env-file .env.production -f deploy/docker-compose.yml \
  --profile ops run --rm \
  -e RESTORE_CONFIRM=I_UNDERSTAND_DATA_REPLACEMENT \
  -e RESTORE_EXPECTED_SHA256=<sha256-verificado> \
  -e BACKUP_FILE=/backup/premise-v2-latest.ndjson \
  backup node /app/ops/restore.mjs
```

El script verifica formato, tenant, orden, conteos y digest antes de abrir la
transacción que limpia y repuebla el tenant. Si el digest esperado no coincide,
se detiene antes de borrar datos. El restore no elimina volúmenes y no debe
ejecutarse con tráfico de escritura concurrente sin un procedimiento de
congelación coordinado.

Antes de un restore real:

- registra el digest, tenant, operador, hora y motivo;
- detén o drena las escrituras;
- conserva el backup anterior y los logs;
- ejecuta primero `restore-verify` en staging o en un entorno aislado;
- mide el tiempo real de recuperación y la pérdida de datos observada.

## 6. Rollback de imagen

Para un rollback simple, `rollback.sh` y `rollback.ps1` requieren una imagen
previamente verificada. Rechazan tags mutables, validan Compose, no reinician
dependencias y usan `--force-recreate --pull never`. Después de readiness,
comparan el ID de imagen del contenedor con el ID de la referencia solicitada.

Linux/macOS:

```bash
PREVIOUS_IMAGE=registry.example/premise-v2@sha256:<64-hex> \
  COMPOSE_FILE=deploy/docker-compose.yml \
  sh deploy/rollback.sh
```

PowerShell:

```powershell
.\deploy\rollback.ps1 -PreviousImage "registry.example/premise-v2@sha256:<64-hex>"
```

El smoke completo de rollback (`deploy/rollback-smoke.mjs`) es más fuerte:
arranca la imagen actual, escribe y lee un registro de verificación, cambia a
la imagen anterior, vuelve a comprobar readiness y demuestra que el registro
permanece. Necesita dos referencias de imagen reales, acceso a Docker y la
confirmación `I_UNDERSTAND_ROLLBACK`. No se considera evidencia si se usan
tags mutables o si el artefacto no se conserva.

## 7. Checklist de liberación

Una liberación no debe etiquetarse como GA únicamente porque el contenedor
arranque. Conserva estas evidencias:

| Control | Evidencia mínima |
| --- | --- |
| Configuración | salida verde de `preflight` y `docker compose config --quiet` |
| Imágenes | referencias por digest y digest de los artefactos construidos |
| Migraciones | logs de `migrate` sin checksum mismatch |
| Readiness | `/readyz` 200 sostenido y `/health` 200 |
| Seguridad | tokens distintos, cuenta RLS sin bypass, claves públicas montadas |
| Métricas | scrape autenticado y reglas cargadas |
| Backup | archivo completo, `verified: true`, digest archivado externamente |
| Restore | `restore-verify` exitoso y tiempo de recuperación medido |
| Rollback | smoke con dos imágenes inmutables y datos conservados |
| Carga | prueba de concurrencia, millones de memorias y fallo/reinicio reales |
| Integraciones | PostgreSQL, GitHub y conectores externos reales, no fixtures locales |
| SLO | precisión, frescura, latencia, coste y disponibilidad medidos con datos independientes |

Los últimos cuatro controles no se pueden inventar desde este repositorio. Si
faltan, el estado correcto es “candidato/RC con evidencia incompleta”, no “GA”.

## 8. Límites conocidos y siguientes controles

- La base de datos Compose es un único PostgreSQL; no ofrece failover ni
  réplica por sí misma.
- Los puertos de observabilidad están ligados a loopback en el ejemplo, pero
  el despliegue real necesita firewall y autenticación de red.
- El archivo de claves públicas no es un KMS; la rotación debe ser externa y
  debe probarse con una ventana de solapamiento de claves.
- El backup local no es un backup externo. La prueba de restore debe ejecutarse
  contra el artefacto almacenado fuera del host.
- Un proceso que reinicia correctamente no prueba disponibilidad. Hay que
  medir una ventana de soak, reinicios, pérdida de PostgreSQL, corrupción
  controlada y recuperación con datos reales.

La política operativa recomendada es mantener estas limitaciones visibles en
el release note y no convertirlas en afirmaciones de producto universal.
