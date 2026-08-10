# Evidencia de rollback de PREMiSE v2

`deploy/rollback-smoke.mjs` es una prueba reproducible para un despliegue con Docker Compose. Comprueba que una versión candidata puede arrancar, escribir y leer un registro persistente, cambiarse de forma controlada a la imagen anterior y conservar tanto el servicio como ese registro.

La prueba no convierte por sí sola a PREMiSE en una solución GA. Es una pieza de evidencia operacional: para una certificación real hay que ejecutarla con dos artefactos de release verificables, en un entorno representativo y con el resto de los gates de seguridad, carga, disponibilidad y conectores.

## Qué valida

La secuencia es deliberadamente fail-closed:

1. Identifica el commit Git y calcula el SHA-256 del fichero Compose utilizado.
2. Exige confirmación explícita, dos referencias de imagen diferentes y un servicio `premise` en el Compose.
3. Comprueba que Docker Engine y Docker Compose están disponibles, y que las dos imágenes existen localmente. Con `ROLLBACK_SMOKE_PULL=1` puede descargarlas antes de inspeccionarlas.
4. Captura el ID real, tags, digests, fecha de creación y labels OCI relevantes de ambas imágenes. Si los IDs son iguales, la prueba se detiene.
5. Levanta la versión candidata con `docker compose up -d --no-build premise` y espera simultáneamente:
   - el estado `healthy` del contenedor;
   - HTTP 200, `ready: true` y `checks.database: "ok"` en `/readyz`;
   - el `healthcheck.mjs` ejecutado dentro del contenedor.
6. Escribe un registro de verificación con un ID único en PostgreSQL y comprueba su lectura por la API.
7. Cambia únicamente el servicio `premise` a la imagen anterior con `--no-deps --force-recreate`. No ejecuta migraciones down, no borra contenedores, no hace `down -v` y no elimina volúmenes.
8. Repite readiness y comprueba que el contenedor utiliza el ID de la imagen anterior.
9. Lee el registro creado antes del cambio, compara su hash JSON canónico y verifica que la API sigue anunciando `premise/2`.
10. Escribe un informe JSON incluso cuando una precondición no se cumple o una fase falla.

Después de un resultado satisfactorio, el stack queda deliberadamente ejecutándose con la imagen anterior. Esto hace observable el estado al que se ha vuelto y evita que la propia prueba oculte un problema con una limpieza destructiva.

## Requisitos y seguridad

La ejecución cambia un servicio y escribe un registro en la base de datos indicada por el Compose. Debe hacerse en staging o en una ventana de operación autorizada, con backup previo y tráfico drenado en el gateway.

Se necesitan:

- Docker Engine accesible y Docker Compose v2;
- `deploy/docker-compose.yml` o un Compose compatible pasado mediante `COMPOSE_FILE`;
- dos imágenes disponibles en el host, o acceso de pull explícito, con IDs distintos;
- un endpoint HTTP accesible desde el host, normalmente `http://127.0.0.1:3000`;
- PostgreSQL y el volumen de datos que el Compose vaya a utilizar;
- una sola réplica del servicio `premise` (la prueba se bloquea si encuentra varias y no puede verificar un rollback parcial);
- un token de API si el servicio está en `PREMISE_ENV=production`.

Las referencias con `@sha256:...` son la opción recomendada. También se admiten tags versionados como `premise-v2:ga-<commit>` porque el informe conserva el ID de imagen que realmente se ejecutó. `latest`, `stable`, `current`, `previous` y `local` se rechazan por defecto; se puede habilitar una fixture con `ROLLBACK_SMOKE_ALLOW_MUTABLE_TAGS=1`, pero esa ejecución no debe presentarse como evidencia de release.

La confirmación obligatoria evita una ejecución accidental:

```powershell
$env:PREMISE_ROLLBACK_CONFIRM = "I_UNDERSTAND_ROLLBACK"
```

El runner no registra `PREMISE_API_TOKEN`, `DATABASE_URL` ni valores de secretos. Si el worktree está sucio lo deja indicado en el informe; para exigir reproducibilidad estricta se puede usar `ROLLBACK_SMOKE_REQUIRE_CLEAN=1`.

## Ejecución con imágenes de release

PowerShell:

```powershell
$env:PREMISE_ROLLBACK_CONFIRM = "I_UNDERSTAND_ROLLBACK"
$env:PREMISE_ROLLBACK_CURRENT_IMAGE = "registry.example/premise-v2@sha256:<candidate-digest>"
$env:PREMISE_ROLLBACK_PREVIOUS_IMAGE = "registry.example/premise-v2@sha256:<previous-digest>"
$env:PREMISE_TENANT_ID = "tenant:rollback-staging"
$env:ROLLBACK_SMOKE_RESULT_FILE = ".ga-artifacts/rollback-smoke.json"
node deploy/rollback-smoke.mjs
```

Linux/macOS:

```bash
export PREMISE_ROLLBACK_CONFIRM=I_UNDERSTAND_ROLLBACK
export PREMISE_ROLLBACK_CURRENT_IMAGE='registry.example/premise-v2@sha256:<candidate-digest>'
export PREMISE_ROLLBACK_PREVIOUS_IMAGE='registry.example/premise-v2@sha256:<previous-digest>'
export PREMISE_TENANT_ID=tenant:rollback-staging
export ROLLBACK_SMOKE_RESULT_FILE=.ga-artifacts/rollback-smoke.json
node deploy/rollback-smoke.mjs
```

Para imágenes que todavía no están en el host:

```powershell
$env:ROLLBACK_SMOKE_PULL = "1"
node deploy/rollback-smoke.mjs
```

El pull no sustituye la verificación de identidad: después del pull se inspeccionan los IDs y el informe conserva `RepoDigests` cuando el runtime los proporciona.

## Fixture reproducible

Una fixture local sirve para validar el mecanismo del runner, no para prometer compatibilidad de releases. Debe tener dos nombres explícitos y no reutilizar `latest`:

```powershell
docker build --build-arg BUILD_VERSION=rollback-fixture-a -f deploy/Dockerfile -t premise-v2:rollback-fixture-a .
docker build --build-arg BUILD_VERSION=rollback-fixture-b -f deploy/Dockerfile -t premise-v2:rollback-fixture-b .
$env:PREMISE_ROLLBACK_CURRENT_IMAGE = "premise-v2:rollback-fixture-b"
$env:PREMISE_ROLLBACK_PREVIOUS_IMAGE = "premise-v2:rollback-fixture-a"
node deploy/rollback-smoke.mjs
```

Para que esta fixture tenga valor como evidencia de release, las dos imágenes deben proceder de commits distintos y sus artefactos deben conservarse junto con sus SBOM, escaneo y digest. Dos builds consecutivos del mismo árbol solo prueban la mecánica de Compose.

## Artefacto auditable

El fichero por defecto es `.ga-artifacts/rollback-smoke.json`. Su forma principal es:

```json
{
  "schema": "premise/rollback-smoke",
  "schemaVersion": 1,
  "status": "passed",
  "ok": true,
  "repository": {
    "commit": "<git-commit>",
    "dirty": false
  },
  "inputs": {
    "composeFileSha256": "<sha256>",
    "runnerSha256": "<sha256>",
    "currentImage": "<candidate-ref>",
    "previousImage": "<previous-ref>"
  },
  "evidence": {
    "imageReferences": {
      "current": { "id": "<image-id>", "repoDigests": [] },
      "previous": { "id": "<image-id>", "repoDigests": [] }
    },
    "data": {
      "before": { "recordSha256": "<sha256>" },
      "after": { "recordSha256": "<same-sha256>" }
    }
  },
  "assertions": []
}
```

El informe real incluye timestamps ISO-8601 por fase, el ID y health status del contenedor antes y después, readiness, health, comandos sin secretos y los detalles de un fallo si lo hubiera. `status: "blocked"` y código de proceso 2 significa que no se reunió una precondición —por ejemplo, Docker ausente, imagen no disponible o falta de confirmación— y nunca significa que el rollback haya pasado.

Un resultado con `status: "failed"` o `ok: false` no es evidencia positiva. Hay que conservarlo para diagnóstico y repetir la operación después de corregir la causa.

## Lo que no cubre

- No valida down-migrations ni compatibilidad de un esquema nuevo con una versión antigua; las migraciones de PREMiSE son forward-only.
- No simula el balanceador, drenaje de tráfico, DNS, KMS, registry privado, proveedor cloud o Alertmanager de un entorno concreto.
- No mide disponibilidad sostenida, coste, RTO/RPO ni recuperación ante una pérdida completa de PostgreSQL.
- No usa el script de incidente `deploy/rollback.sh` porque necesita envolver el cambio con una escritura, una comparación de datos y evidencia de las dos versiones. La operación de producción sigue requiriendo el procedimiento de `docs/ga-operations.md`.

Por ello el artefacto debe aparecer como una señal dentro del expediente GA, nunca como la única prueba de que PREMiSE es una solución universal.
