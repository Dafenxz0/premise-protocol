# PREMiSE v2

Contrato aditivo separado de `premise/0.1`. La implementación TypeScript está
en `packages/protocol-types/src/v2.ts` y se exporta desde el paquete raíz.
`premise/0.1` y sus validadores no cambian.

## Envelope

Un envelope v2 usa `specVersion: "premise/2"` y exige:

- `tenantId`, porque `memoryId`, `dependsOn`, evidencias y operaciones están
  aislados dentro de un tenant;
- `evidence[]`, con `evidenceId`, fuente, `observedAt` y, opcionalmente,
  versión/validator, ventana temporal y confianza por evidencia;
- `confidence`, una declaración con `score` entre `0` y `1` o `null` si no hay
  puntuación, además del método que la produjo;
- `conflicts[]`, cuyos conflictos abiertos no permiten declarar `FRESH`;
  resolver uno exige estrategia, instante y, si se selecciona evidencia, una
  referencia a la evidencia del conflicto;
- `temporal.asOf` y una ventana opcional `validFrom`/`validUntil`;
- `validity`, `dependsOn` y `contentDigest`, con semántica equivalente a v1;
- `signatures[]`, declaraciones de `signerId`, `keyId`, algoritmo, valor e
  instante. Son metadatos declarados: v2 no verifica criptografía.

`evidence` puede estar vacío únicamente cuando `dependsOn` contiene al menos
una memoria. Las dependencias no llevan tenant propio: siempre pertenecen al
tenant del envelope.

Ejemplo mínimo:

```json
{
  "specVersion": "premise/2",
  "tenantId": "tenant:acme",
  "memoryId": "memory:42",
  "evidence": [
    { "evidenceId": "e:1", "sourceUri": "github://pr/42", "observedAt": "2026-08-09T19:20:00Z" },
    { "evidenceId": "e:2", "sourceUri": "ci://pr/42", "observedAt": "2026-08-09T19:20:00Z" }
  ],
  "confidence": { "score": 0.85, "method": "weighted-evidence" },
  "conflicts": [],
  "temporal": { "asOf": "2026-08-09T19:20:00Z" },
  "validity": { "status": "FRESH", "checkedAt": "2026-08-09T19:20:00Z", "policy": "MANUAL" },
  "dependsOn": [],
  "signatures": []
}
```

## Operaciones e idempotencia

Una petición v2 lleva `tenantId`, `operationId`, `operation`, `idempotencyKey`,
`requestDigest` (`sha256:...`) y `requestedAt`. La clave se busca en el ámbito
`(tenantId, operation, idempotencyKey)`:

- clave nueva: `NEW`;
- misma clave y mismo digest: `REPLAY`, sin una segunda mutación;
- misma clave y digest distinto: `CONFLICT`.

Los eventos v2 repiten el contexto de tenant e idempotencia para que la
historia sea auditable. El contrato valida forma e identidad, no implementa un
almacén ni resuelve automáticamente conflictos o confianza.

## Migración desde v1

`migrateV1Envelope(envelope, { tenantId, migratedAt? })` valida primero el
envelope v1 y luego:

- convierte cada `provenance` en una entrada `evidence` estable (`v1:1`, ...);
- conserva `contentDigest`, versiones, validators, `validity` y `dependsOn`;
- usa `temporal.asOf` en `migratedAt` o en `validity.checkedAt`;
- crea `conflicts` y `signatures` vacíos y expresa la confianza desconocida
  como `score: null`.

El tenant es obligatorio porque v1 no lo contiene. Una migración no verifica
firmas, no inventa una puntuación de confianza y no modifica ningún dato v1.
