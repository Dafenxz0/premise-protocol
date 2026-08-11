# Holdout externo, ciego e independiente de PREMiSE

Este contrato es la frontera entre una comprobación local y una evidencia que puede apoyar una afirmación pública. El runner de `benchmarks/ga-evaluation/holdout/runner.mjs` no lee `datasets/v1.json`, no lee el split `holdout` existente y no convierte fixtures locales en resultados externos.

## Qué hace y qué no hace

El runner descarga un manifiesto HTTPS fijado a un SHA-256. El manifiesto apunta a dos documentos JSON distintos:

- un conjunto de tareas públicas, que el candidato sí puede recibir;
- un conjunto de labels/respuestas doradas, que se descarga únicamente después de terminar el candidato y nunca se le envía.

Cada tarea usa el adaptador GitHub real en modo exclusivamente `GET`. El endpoint se valida contra el repositorio declarado por el manifiesto; el candidato nunca puede elegir una URL arbitraria ni ejecutar escrituras. El runner registra las observaciones de GitHub como fuente viva, pero los hashes de la campaña corresponden al manifiesto, las tareas y los labels publicados por el evaluador externo.

Un resultado normal se clasifica como `CANDIDATE_EVIDENCE`. Es una observación útil para depurar y comparar, pero no es evidencia independiente ni habilita una afirmación GA. Solo aparece `INDEPENDENT_EVIDENCE` cuando una atestación externa, descargada por HTTPS, fijada a SHA-256 y firmada con una clave Ed25519 configurada fuera del candidato, enlaza exactamente:

- los hashes del manifiesto, tareas y labels;
- el hash de las respuestas del candidato y la huella de la ejecución;
- el commit completo evaluado;
- que el runner independiente accedió a los labels después de las respuestas;
- que el adaptador fue read-only y no se usaron fixtures.

Por tanto, la ejecución de tests locales nunca puede producir evidencia externa.

Para cerrar el gate GA no basta con que la atestación sea válida. El resultado
debe conservar `status: "INDEPENDENT_EVIDENCE"`, `evidence.class:
"independent"` y `eligibleForPublicClaim: true`; además debe incluir al menos
200 tareas, precisión ≥ 95 %, frescura ≥ 99 %, denominador de frescura no nulo,
`writeRequests: 0`, y las verificaciones de que los labels se cargaron después
del candidato, nunca se le enviaron y no procedían de fixtures. El gate lee los
umbrales de `spec/ga/acceptance.json` y rechaza un documento que solo tenga
metadatos o un booleano `independent: true`.

## Contrato de los documentos externos

El evaluador publica un manifiesto con este esquema conceptual. Los valores de URL y hash siguientes son ilustrativos; no son una campaña real y no deben copiarse como evidencia.

```json
{
  "format": "premise-ga-holdout-manifest/1",
  "version": "1.0.0",
  "campaign": {
    "id": "campaign-YYYY-MM-DD",
    "split": "holdout",
    "kind": "external-blind",
    "publisher": "independent-evaluator",
    "createdAt": "2026-08-10T00:00:00Z"
  },
  "source": {
    "adapter": "github",
    "apiBase": "https://api.github.com",
    "repository": "owner/repository",
    "readOnly": true
  },
  "dataset": {
    "tasks": {
      "url": "https://external-evaluator.example/holdout/tasks.json",
      "sha256": "<64 lowercase hex characters>",
      "mediaType": "application/json",
      "immutable": true
    },
    "labels": {
      "url": "https://external-evaluator.example/holdout/labels.json",
      "sha256": "<64 lowercase hex characters>",
      "mediaType": "application/json",
      "immutable": true,
      "sealed": true
    }
  },
  "independence": {
    "required": true,
    "labelsSealed": true,
    "separateRunner": true,
    "candidateEvidenceAllowed": true
  }
}
```

`tasks.json` debe tener `format: "premise-ga-holdout-tasks/1"` y una lista de objetos `{id, prompt, source}`. `source` solo admite `{id, adapter: "github", method: "GET", path}`; el path debe estar dentro de `/repos/<repository>/`. No puede contener `answer`, `gold`, `oracle`, `expected` ni otros campos de respuesta.

`labels.json` debe tener `format: "premise-ga-holdout-labels/1"` y exactamente un `{taskId, answer}` por tarea. Puede añadir `sourceVersion` para medir frescura. El runner mantiene ese documento en memoria y nunca lo serializa en `responses.jsonl`, `results.json` ni en las trazas.

La inmutabilidad se prueba por contenido: los tres bytes descargados se recalculan con SHA-256 antes de parsearse. HTTPS, una URL externa y un hash no prueban que el editor sea independiente; por eso el resultado sigue siendo candidato hasta verificar la atestación separada.

La clave pública de la atestación debe llegar por un canal de confianza distinto
del repositorio del candidato. La presencia de una firma válida demuestra que el
payload fue firmado por la clave configurada; la decisión de independencia exige
además verificar quién controla esa clave, quién custodia el corpus y que el
runner no fue ajustado contra las labels.

## Ejecución real

Se necesitan una URL real, su hash publicado por el evaluador y un candidato. No se admite `--manifest-file`, `file://`, `fixture://`, `data:` ni hosts locales/privados.

```powershell
$env:PREMISE_HOLDOUT_MANIFEST_URL = "https://<evaluador-real>/holdout/manifest.json"
$env:PREMISE_HOLDOUT_MANIFEST_SHA256 = "<hash-publicado-del-manifiesto>"
$env:PREMISE_HOLDOUT_CANDIDATE = "node benchmarks/ga-evaluation/holdout/candidate.mjs"
$env:PREMISE_CANDIDATE_COMMIT = "<40-char-git-sha>"
$env:GITHUB_TOKEN = "<token-de-solo-lectura>" # opcional para un repositorio privado
pnpm build # el candidato usa el runtime v2 compilado
node benchmarks/ga-evaluation/holdout/runner.mjs --require-independent
```

También se pueden pasar `--manifest-url`, `--manifest-sha256`, `--candidate` y `--output-dir`. Para un manifiesto privado se usa `PREMISE_HOLDOUT_BEARER_TOKEN`; nunca se debe incrustar un secreto en la URL. El token se queda en el proceso del runner y se elimina del entorno del candidato.

Si falta la URL, el hash o el candidato, el proceso termina con estado `NOT_ELIGIBLE` y código 2. Si se pide `--require-independent` sin atestación, sin clave, sin commit completo o con cualquier hash/firma incorrectos, termina cerrado y no escribe un pass. Sin `--require-independent`, una campaña válida puede producir `CANDIDATE_EVIDENCE`, explícitamente no elegible para una reclamación independiente.

Un resultado independiente tampoco autoriza claims universales: solo respalda
las tareas, fuentes, hashes, commit, runner y atestación concretos. No demuestra
por sí solo disponibilidad, coste, TLS/OIDC, custodia KMS/HSM, seguridad
operativa ni calidad de conectores distintos de GitHub.

El protocolo NDJSON que recibe el candidato es deliberadamente pequeño:

```text
runner -> {"type":"task","task":{"protocol":"premise-ga-holdout/1", ...}}
candidate -> {"type":"read","sourceId":"opaque-source-..."}
runner -> {"type":"evidence","content":"...","version":{...}, ...}
candidate -> {"type":"answer","answer":...,"decision":"USE"}
runner -> {"type":"end"}
```

El candidato puede pedir `read` o `version` para el `sourceId` opaco de la tarea activa. `log` se ignora. Cualquier intento de pedir otro source, usar un mensaje desconocido, superar 1 MiB por línea o agotar el timeout aborta la ejecución.

Salidas:

- `responses.jsonl`: respuestas y observaciones del candidato; no contiene labels ni respuestas esperadas.
- `results.json` y `external-holdout.json`: métricas, trazas con digests, hashes y la clase de evidencia; no contienen labels.
- `dataset-manifest.json`: solo metadatos y hashes de los tres documentos fijados; no copia tareas ni labels.
- `provenance.json`: procedencia resumida y hash de respuestas; tampoco contiene labels.

## Atestación de independencia

El evaluador independiente debe publicar un JSON externo con `format: "premise-ga-holdout-attestation/1"`, `status: "independent"`, los campos de hash de la ejecución, `candidateCommit`, `independentRunnerId`, `evaluatorId`, `labelsAccessedAfterResponses: true`, `sourceReadOnly: true`, `fixturesUsed: false` y una firma Ed25519 sobre el JSON canónico sin el campo `signature`.

Se configura con:

```powershell
$env:PREMISE_HOLDOUT_ATTESTATION_URL = "https://<evaluador-real>/holdout/attestation.json"
$env:PREMISE_HOLDOUT_ATTESTATION_SHA256 = "<hash-publicado-de-la-atestacion>"
$env:PREMISE_HOLDOUT_ATTESTATION_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----..."
node benchmarks/ga-evaluation/holdout/runner.mjs --require-independent
```

La firma no convierte por sí sola a un proveedor en independiente: la clave pública debe distribuirse por un canal de confianza distinto del candidato y el runner debe pertenecer al evaluador externo. La atestación es la unión verificable entre esos hechos y los artefactos concretos.

## Test del contrato

El test siguiente solo usa objetos en memoria, hashes conocidos y URLs de prueba. No hace llamadas de red y no escribe `results.json`:

```powershell
node benchmarks/ga-evaluation/holdout/contract.test.mjs
```

Su salida debe indicar `testType: "holdout-contract"`, `networkCalls: 0` y `externalEvidenceProduced: false`. Esto valida el contrato, no una campaña externa.

## Límite de las afirmaciones

Una tabla de `CANDIDATE_EVIDENCE` puede orientar el desarrollo, pero no prueba independencia, generalización, disponibilidad, coste de proveedor ni superioridad universal. Una tabla de `INDEPENDENT_EVIDENCE` solo respalda las métricas de ese manifiesto, esos hashes, ese commit, esa ejecución y esa atestación. Para una promesa pública de PREMiSE v2.0 GA todavía se necesitan campañas externas repetidas, cambios reales en la fuente, otros conectores y el resto de las puertas de carga, seguridad, operaciones y disponibilidad.
