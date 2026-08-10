# PREMiSE v2: operación y despliegue GA

Esta guía describe un despliegue reproducible, local y con forma de producción para PREMiSE v2. El alcance operativo está en deploy/**, ops/** y este documento. El workflow existente CI no se modifica: las comprobaciones GA viven en .github/workflows/ga.yml.

## Qué se entrega

La imagen ejecuta la API v2 con un usuario sin privilegios (10001:10001). El proceso carga los recuerdos y eventos desde PostgreSQL al arrancar, mantiene el índice de consulta en memoria y confirma las escrituras en PostgreSQL antes de responder con éxito. Si la persistencia falla, las operaciones de escritura devuelven 503, readiness pasa a rojo y hay que reiniciar el proceso después de corregir la base de datos.

~~~mermaid
flowchart LR
  Client[Cliente o gateway autenticado] --> API[PREMiSE v2 :3000]
  API --> Mirror[Mirror síncrono en memoria]
  Mirror --> PG[(PostgreSQL 16)]
  API --> Prom[Prometheus /metrics]
  API -. OTLP estándar .-> OTel[OpenTelemetry Collector]
  OTel --> Prom
~~~

postgres, migrate, premise, prometheus y otel-collector están definidos en deploy/docker-compose.yml. backup se activa solo con el perfil ops.

No hay credenciales reales en el repositorio. Los ficheros deploy/.env.example y deploy/config/*.env.example contienen valores locales o marcadores __INJECT_*__; staging y producción deben recibir DATABASE_URL y el tenant desde el gestor de secretos o el entorno de ejecución.

El proceso se configura con un tenant por instancia. El backup y el restore operativos cubren ese tenant; para varios tenants se ejecuta una operación por tenant o se usa un rol de administración específico del entorno.

## Arranque local

Desde la raíz del repositorio:

~~~bash
mkdir -p .local/backups
chmod 0777 .local/backups
docker compose --env-file deploy/.env.example -f deploy/docker-compose.yml up -d
~~~

En PowerShell:

~~~powershell
New-Item -ItemType Directory -Force .local/backups | Out-Null
docker compose --env-file deploy/.env.example -f deploy/docker-compose.yml up -d
~~~

La primera puesta en marcha construye la imagen, espera a que PostgreSQL responda y ejecuta las migraciones con checksum y bloqueo advisory. Para ver el estado:

~~~bash
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs --tail=100 migrate premise
~~~

La base local usa local-only-not-for-production, que es un marcador de desarrollo y no debe reutilizarse fuera de un entorno local.

## Verificaciones reproducibles

Health indica que el proceso está vivo; readiness confirma proceso, store y PostgreSQL:

~~~bash
docker compose -f deploy/docker-compose.yml exec -T -e PREMISE_HEALTH_PATH=/health premise node /app/ops/healthcheck.mjs
docker compose -f deploy/docker-compose.yml exec -T premise node /app/ops/healthcheck.mjs
~~~

Smoke test de la API v2:

~~~bash
docker compose -f deploy/docker-compose.yml exec -T premise node /app/ops/smoke.mjs
~~~

Carga acotada para CI o una comprobación manual:

~~~bash
docker compose -f deploy/docker-compose.yml exec -T \
  -e PREMISE_LOAD_REQUESTS=32 \
  -e PREMISE_LOAD_CONCURRENCY=4 \
  -e PREMISE_LOAD_MAX_P95_MS=500 \
  premise node /app/ops/load-smoke.mjs
~~~

El espejo durable procesa escrituras con concurrencia acotada para no bloquear
todo el servicio ni saturar PostgreSQL. El valor por defecto es `4`; se puede
ajustar por despliegue con `PREMISE_RUNTIME_WRITE_CONCURRENCY` (entero entre 1
y 64). Las rutas de lectura no esperan esa cola; las mutaciones sí esperan su
barrera de durabilidad antes de responder.

Métricas Prometheus:

~~~bash
curl http://127.0.0.1:3000/metrics
~~~

La UI local de Prometheus está en http://127.0.0.1:9090. El collector acepta OTLP/gRPC en 4317 y OTLP/HTTP en 4318, y expone sus métricas Prometheus en 8889. La API publica métricas Prometheus directamente; no se incluye un SDK de telemetría obligatorio. OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES, OTEL_EXPORTER_OTLP_* y OTEL_PROPAGATORS quedan preparados para instrumentación automática o un gateway que propague traceparent.

## Migraciones

Las migraciones están en deploy/migrations/ y se aplican en orden lexicográfico. ops/migrate.mjs:

- registra versión, nombre, checksum y hora en la tabla de migraciones del prefijo configurado;
- vuelve a comprobar el checksum de una migración ya aplicada;
- usa pg_advisory_lock, de modo que dos réplicas no migran a la vez;
- ejecuta cada fichero dentro de una transacción.

El arranque normal ya ejecuta el servicio migrate. Para ejecutarlo explícitamente:

~~~bash
docker compose -f deploy/docker-compose.yml run --rm migrate
~~~

Las migraciones son forward-only. Antes de publicar una imagen nueva, primero debe ser compatible con el esquema existente. El rollback de una imagen no hace down-migration automáticamente.

## Backup y restore verificado

El backup es un snapshot JSON de los registros y eventos v2, con SHA-256 y permisos de fichero restrictivos. El restore de verificación restaura en tablas temporales, compara registros/eventos y las elimina; no cambia el store activo.

~~~bash
docker compose -f deploy/docker-compose.yml --profile ops run --rm backup
docker compose -f deploy/docker-compose.yml --profile ops run --rm backup \
  node /app/ops/restore-verify.mjs
~~~

El fichero queda en .local/backups/premise-v2-latest.json. Antes de una operación destructiva, conservar una copia externa y parar la API:

~~~bash
docker compose -f deploy/docker-compose.yml stop premise
docker compose -f deploy/docker-compose.yml --profile ops run --rm \
  -e RESTORE_CONFIRM=I_UNDERSTAND_DATA_REPLACEMENT \
  backup node /app/ops/restore.mjs
docker compose -f deploy/docker-compose.yml up -d premise
docker compose -f deploy/docker-compose.yml exec -T -e PREMISE_HEALTH_PATH=/readyz premise node /app/ops/healthcheck.mjs
~~~

El restore activo exige deliberadamente RESTORE_CONFIRM=I_UNDERSTAND_DATA_REPLACEMENT. Nunca se imprimen DATABASE_URL ni el contenido del backup en los logs de la operación.

## Rollback

Cada despliegue debe conservar una referencia inmutable de la imagen anterior, preferiblemente un digest. El rollback cambia solo la imagen; no borra datos ni intenta revertir el esquema:

~~~bash
export PREVIOUS_IMAGE=registry.example.invalid/premise-v2@sha256:REPLACE_WITH_A_VERIFIED_DIGEST
docker pull "$PREVIOUS_IMAGE"
PREVIOUS_IMAGE="$PREVIOUS_IMAGE" ./deploy/rollback.sh
~~~

En PowerShell:

~~~powershell
$previous = "registry.example.invalid/premise-v2@sha256:REPLACE_WITH_A_VERIFIED_DIGEST"
docker pull $previous
.\deploy\rollback.ps1 -PreviousImage $previous
~~~

Secuencia recomendada: detener el tráfico en el gateway, conservar el backup, cambiar al digest anterior, comprobar readiness y smoke, y reabrir el tráfico. Si la versión anterior no entiende el esquema actual, restaurar el backup validado en una ventana de mantenimiento; no improvisar un DROP TABLE.

## Alertas y umbrales

deploy/alert-rules.yml contiene reglas listas para cargar en Prometheus:

| Señal | Umbral | Ventana |
| --- | ---: | ---: |
| p95 de latencia HTTP | > 500 ms | 10 min |
| p99 de latencia HTTP | > 2.000 ms | 10 min |
| error-rate HTTP 5xx | > 0,1% | 10 min |
| error-rate HTTP 4xx | > 0,1% | 10 min |
| recuerdos STALE/UNKNOWN | > 10% | 15 min |
| recuerdos INVALID | > 0 | 10 min |
| store no listo | 0 | 5 min |

Las alertas no contienen receptores ni tokens. Conectar Alertmanager, PagerDuty, Slack u otro canal pertenece al entorno de cada operador.
El runner de soak también cuenta timeouts y fallos semánticos de respuestas 2xx;
esas señales no se pueden inferir únicamente de un contador HTTP y deben
revisarse en el artefacto de la campaña.

## Seguridad operativa

- El contenedor de PREMiSE no es root, usa filesystem de solo lectura, elimina capabilities y activa no-new-privileges en Compose.
- PostgreSQL no publica un puerto al host en el Compose local; solo la API y las UIs locales se publican en loopback.
- x-premise-tenant y x-premise-subject no son autenticación y están desactivados por defecto. En producción, `PREMISE_ENV=production` exige `PREMISE_API_TOKEN` (mínimo 32 caracteres) y rechaza cualquier petición sin `Authorization: Bearer ...`; inyectarlo desde un gestor de secretos, nunca desde el repositorio.
- El proceso no registra la URL de conexión ni secretos. Inyectar DATABASE_URL en runtime; no ponerla en commits, imágenes, artefactos ni comentarios de workflow.
- El gate GA ejecuta pnpm audit, Trivy sobre el filesystem y la imagen, comprueba que la imagen corre como 10001:10001, ejecuta smoke/load y verifica backup/restore.

## Qué debe comprobar una persona no técnica

1. El workflow GA release gates termina en verde y conserva su artefacto durante 14 días.
2. El backup y restore-verify aparecen en verde antes de abrir tráfico.
3. Readiness está en verde después de la migración.
4. Prometheus no muestra alertas activas de error-rate, latencia o frescura.
5. Si algo sale mal, se pausa el tráfico y se entrega al operador el digest anterior y el último backup verificado; no se modifican tablas manualmente.

## Limpieza local

Para detener y eliminar los volúmenes locales de prueba:

~~~bash
docker compose -f deploy/docker-compose.yml --profile ops down -v
~~~

Esto elimina los datos locales de PostgreSQL y Prometheus del proyecto Compose. En un entorno real, conservar el backup antes de ejecutar una limpieza.
