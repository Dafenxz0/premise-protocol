# Compatibilidad e interoperabilidad

## Perfil base

Una implementación que anuncie `PREMiSE-compatible premise/1` MUST declarar y
cumplir estas capabilities:

- `RECORD`: registra y conserva envelopes sin contenido;
- `DEPENDENCY`: conserva el DAG, rechaza ciclos y propaga cambios;
- `REVALIDATION`: aplica validators y sus cuatro resultados;
- `TENANCY`: aísla `tenantId` en memoria, dependencias, operaciones y eventos;
- `IDEMPOTENCY`: aplica el resultado `NEW`/`REPLAY`/`CONFLICT` en el ámbito
  normativo.

`RETRIEVAL` y `GATE` son opcionales. Si se anuncian, deben cumplir
[`decisions.md`](./decisions.md); no se presuponen por estar presente el
protocolo.

## Reglas de negociación

1. `specVersion` debe ser exactamente `premise/1` en cada documento. Un
   consumidor MUST rechazar otro valor antes de aplicar una mutación.
2. Los campos desconocidos y las capabilities desconocidas se rechazan; no se
   descartan silenciosamente.
3. El orden de eventos es historia. El orden de `dependsOn` se conserva en la
   representación aunque la propagación pueda ordenar sus resultados por
   `memoryId`.
4. Un proveedor puede ofrecer un subconjunto opcional, pero no puede anunciar
   el perfil base si falta una capability obligatoria.
5. Las diferencias de transporte, almacenamiento, autenticación o retrieval
   no cambian la semántica del contrato; deben documentarse fuera del
   envelope.
6. Una versión futura necesita un nuevo `specVersion` o una negociación
   explícita. `premise/1` no acepta una versión futura por comparación de
   prefijo.

## Relación con otros contratos

`premise/0.1` y `premise/2` son identificadores distintos. No hay
compatibilidad wire implícita:

- **Importar `premise/0.1`**: un adaptador puede convertir `provenance` en
  `evidence`, conservar `validity` y `dependsOn`, y recibir un `tenantId`
  explícito. La confianza desconocida permanece desconocida; no se inventa
  una puntuación.
- **Exportar a `premise/0.1`**: solo es válido si el consumidor acepta perder
  campos que no existen en v0.1, como tenancy, idempotencia o evidencia
  múltiple. El adaptador MUST señalar la pérdida y no puede fingir que el
  envelope es idéntico.
- **Interoperar con `premise/2`**: requiere un adaptador negociado que valide
  ambos contratos. Un endpoint `premise/1` MUST NOT tratar un envelope
  `premise/2` como si fuera `premise/1`.

## Rechazo y seguridad semántica

Un consumidor compatible MUST rechazar, sin efectos laterales:

- `specVersion` incorrecto;
- tenant ausente, cruzado o no autorizado por el contexto de la operación;
- campos no permitidos o pares `version`/`validator` incompletos;
- dependencias ausentes, duplicadas o cíclicas;
- digest de idempotencia en conflicto;
- una declaración que presenta `INVALID` como `USE`.

La compatibilidad no es una afirmación de verdad externa, validez de firma ni
disponibilidad del validator. Es cumplimiento reproducible de la forma y la
semántica mínimas de este directorio.
