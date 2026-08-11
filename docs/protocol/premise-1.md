# PREMiSE `premise/1`: claims, evidencia y conformance

`premise/1` es un contrato normativo mínimo para conservar metadata de
validez: qué evidencia respalda una memoria, qué estado tiene y qué decisión
de uso puede tomar un consumidor. No es una memoria principal, un buscador, una
base vectorial ni un almacén del contenido.

Esta página separa tres cosas que no deben confundirse: el claim normativo del
protocolo, la evidencia ejecutable de sus vectores y la evidencia live de una
implementación integrada con una fuente real.

## Claims del contrato

| Claim | Evidencia normativa o ejecutable | Qué no demuestra |
| --- | --- | --- |
| Un documento compatible lleva exactamente `specVersion: "premise/1"`; una versión futura no es un alias. | [`README.md`](../../spec/premise-1/README.md), [`compatibility.md`](../../spec/premise-1/compatibility.md), [`compatibility.json`](../../spec/premise-1/compatibility.json) y la regla `exact-version`. | Compatibilidad wire con `premise/0.1` o `premise/2`; requiere adapter y negociación explícitos. |
| El envelope conserva `tenantId`, `memoryId`, `evidence`, versiones, validators, `dependsOn` y `validity`, sin transportar el contenido. | [`model.md`](../../spec/premise-1/model.md) y [`contract.schema.json`](../../spec/premise-1/contract.schema.json). El contrato cerrado rechaza campos desconocidos y pares incompletos `version`/`validator`. | Que la evidencia externa sea verdadera, que el validator esté disponible o que una firma declarada haya sido verificada. |
| Los estados efectivos son `FRESH`, `STALE`, `INVALID` y `UNKNOWN`, con prioridad `INVALID > UNKNOWN > STALE > FRESH`. | [`states.md`](../../spec/premise-1/states.md) y los vectores `stale-version.json`, `invalid-invalidation.json`, `unknown-source.json` y `dependency-cascade.json`. | Que una etiqueta stale o fresh por sí sola autorice una acción; la decisión debe calcularse con `check`. |
| `check` devuelve `USE`, `REVALIDATE` o `REJECT` sin mutar estado ni emitir eventos; `INVALID`, `UNKNOWN`, conflicto abierto o dependencia inválida no pueden presentarse como `USE`. | [`decisions.md`](../../spec/premise-1/decisions.md), `fresh-use.json`, `revalidation.json` e `invalid-invalidation.json`. | Que el adapter haya bloqueado realmente una escritura o resuelto un TOCTOU físico; eso pertenece a la capability `GATE` y al target de la integración. |
| Las dependencias forman un DAG, propagan cambios a los dependientes alcanzables y aíslan ramas y tenants no relacionados. | [`model.md`](../../spec/premise-1/model.md), [`states.md`](../../spec/premise-1/states.md), `dependency-cascade.json` y `tenant-isolation.json`. | Rendimiento del grafo en producción o aislamiento de una base de datos que no implemente el contrato. |
| Las mutaciones tienen `operationId`, `idempotencyKey`, `requestDigest` y semántica `NEW`/`REPLAY`/`CONFLICT`; los eventos son append-only y ordenados. | Secciones de operaciones y eventos de [`model.md`](../../spec/premise-1/model.md), `idempotent-replay.json` y el vector `05-compatibility.json`. | Durabilidad, replicación, autenticación o entrega exactamente-una-vez del transporte. |

Las palabras `MUST`, `MUST NOT`, `SHOULD` y `MAY` son normativas en el
directorio [`spec/premise-1/`](../../spec/premise-1/). Esta página resume la
lectura; no sustituye el schema ni la semántica de los documentos normativos.

## Semántica que debe permanecer visible

### Estados y decisiones

| Estado efectivo | Decisión mínima | Regla de uso |
| --- | --- | --- |
| `FRESH` | `USE` | La evidencia y las dependencias permiten usar la memoria. |
| `STALE` | `REVALIDATE` | Debe obtenerse una comprobación antes de usarla. |
| `UNKNOWN` | `REJECT` | La falta de certeza no autoriza el uso actual. |
| `INVALID` | `REJECT` | No puede usarse como soporte actual. |
| ID no registrado | `REJECT` | No hay base de validez que consultar. |

`UNCHANGED` puede reparar `STALE` o `UNKNOWN` cuando la versión registrada
coincide, pero no repara silenciosamente `INVALID`. Para ello hace falta
`replace` o una operación explícita equivalente con una observación nueva.
Una dependencia `INVALID` invalida al derivado; una dependencia ausente o un
ciclo se rechazan como error de contrato.

### Evidencia y límites de `GATE`

La evidencia es una observación identificable por `evidenceId`, `sourceUri` y
`observedAt`; `version` y `validator` se conservan como pareja cuando se
declaran. `validity` es una proyección (`IMMUTABLE`, `VERSIONED`, `TTL` o
`MANUAL`), no una afirmación de verdad eterna.

`check` es solo lectura. Un adapter que anuncia `GATE` MUST comprobar antes de
una acción: permite solo `USE`, revalida ante `REVALIDATE` y bloquea ante
`REJECT`, conservando `memoryId`, estado, decisión y razón en su auditoría si
ofrece auditoría. El protocolo define la decisión portable; la atomicidad del
write, el compare-and-set, la transacción y el retry deben estar garantizados
por el adapter y la fuente. No se debe presentar un `check` local como prueba
de que una escritura remota no sufrió TOCTOU.

## Evidencia y métricas de conformance

Hay dos corpus relacionados, con funciones distintas:

1. [`spec/premise-1/test-vectors/manifest.json`](../../spec/premise-1/test-vectors/manifest.json)
   es el corpus de contrato wire: cinco archivos de vectores (`positive`,
   `transition` y `negative`) para envelope, estados, propagación, decisiones
   y compatibilidad.
2. [`spec/premise-1/vectors/manifest.json`](../../spec/premise-1/vectors/manifest.json)
   es el corpus semántico ejecutado por el gate: nueve escenarios de fresh use,
   versión stale, invalidación, fuente desconocida, cascada, revalidación,
   replay idempotente, aislamiento de tenant y rechazo TOCTOU.

La entrada ejecutable es [`conformance/run.mjs`](../../conformance/run.mjs).
Construye la referencia TypeScript, ejecuta la referencia Python y compara las
tres salidas —TypeScript, Python y expected— con timestamps, arrays y eventos
en orden significativo. El resultado mínimo legible de una ejecución correcta
es `9 vectors; TypeScript == Python == expected`.

Las métricas de este gate son:

| Métrica | Definición | Interpretación |
| --- | --- | --- |
| Vectores totales | Número de entradas del manifiesto semántico: 9 en `0.1`. | Denominador de la ejecución. |
| Vectores correctos | Salidas que coinciden con `expected` tras canonicalizar solo el orden de claves de objetos. | Conformance de esa referencia y ese corpus. |
| Mismatch entre referencias | Diferencia TypeScript/Python. | Fallo de portabilidad; debe ser 0 para PASS. |
| Mismatch contra expected | Diferencia de la salida con el vector esperado. | Fallo semántico; debe ser 0 para PASS. |
| Efectos de operación rechazada | Cambios de estado, grafo o historia y eventos producidos por una operación rechazada. | La norma exige 0 efectos y 0 eventos. |

No hay un claim de p50, p95, throughput, coste, retrieval o calidad de modelo
en este gate. Si se miden, deben publicarse como una evaluación aparte, con
su entorno, denominador y limitaciones.

## Ejecución reproducible

```powershell
pnpm conformance:premise1
```

La orden no necesita base de datos, red, modelo, API key ni proveedor externo.
Debe ejecutarse con el engine del workspace (Node 24.x y pnpm 10.x); con otra
versión `pnpm` puede detenerse antes de invocar el gate por incompatibilidad de
engine. [`conformance/test.mjs`](../../conformance/test.mjs) ofrece además una
aserción Node sobre la salida `PASS`.
Para una comprobación independiente de que los JSON del corpus son legibles,
se puede ejecutar:

```powershell
node --input-type=module -e "import { readdir, readFile } from 'node:fs/promises'; const dir='spec/premise-1/test-vectors'; const files=(await readdir(dir)).filter((file)=>file.endsWith('.json')); for (const file of files) JSON.parse(await readFile(dir+'/'+file,'utf8')); console.log('premise/1 JSON OK ('+files.length+' files)')"
```

Para registrar evidencia de una ejecución se deben conservar el commit o
hashes de `spec/premise-1/`, las versiones de Node/Python/pnpm, la salida del
gate y cualquier diff de los vectores. Una diferencia en un vector, schema,
referencia o regla de comparación crea una nueva campaña de conformance; no
se deben mover los umbrales después de observar el resultado.

## Smoke frente a live

La conformance local es un **smoke offline** del contrato: usa vectores
deterministas y dos referencias locales. Su `PASS` significa que esas
referencias coinciden con el corpus esperado; no significa que una
implementación arbitraria, una fuente real o un adapter de acciones sea
correcto en producción.

Una prueba **live** es una evaluación de integración separada. Debe declarar,
como mínimo, la implementación y versión de `premise/1`, capabilities
anunciadas, tenant y target controlado, validator y esquema de versión, si el
target es read-only o admite writes guardados, eventos observados, errores,
latencia y política de cleanup. Debe ejercitar cambios reales controlados,
revalidación, propagación, idempotencia y el límite de acción que el adapter
afirma proteger.

| Resultado | Significado |
| --- | --- |
| `PASS` del smoke/conformance | Vectores locales correctos; claim limitado al contrato y a las referencias ejecutadas. |
| `PASS_READ_ONLY` de un probe live | Conectividad y lectura de un target configurado; no prueba mutación, recuperación ni GATE. |
| `NOT_RUN` | Faltan credenciales, target controlado, driver, dependencia o condición preregistrada; no es un cero ni un PASS. |
| `FAIL` | El target estaba configurado y la comprobación produjo un error o una discrepancia. Debe conservarse la evidencia. |

No se deben mezclar en una misma tabla los nueve vectores locales, una sonda
live de lectura y un benchmark de agente. Para el benchmark de cambios y
TOCTOU, véase [`docs/benchmarks/premisebench-agent.md`](../benchmarks/premisebench-agent.md).

## Límites del claim

- El contrato exige forma y semántica reproducibles; no certifica que la
  evidencia externa sea verdadera ni que un validator esté disponible.
- La firma declarada en el envelope es metadata en este contrato mínimo; la
  verificación criptográfica, si existe, pertenece a otra capability o capa.
- `RETRIEVAL` y `GATE` son capabilities opcionales. Un proveedor sin `GATE` no
  puede afirmar que protegió una acción solo por exponer `check` o retrieval.
- La conformance usa un corpus pequeño y determinista, con labels conocidas
  por el evaluador. No es un holdout externo, una prueba de carga, un test de
  fuzzing ni una garantía de disponibilidad.
- El orden de eventos y la historia son parte del contrato, pero la
  durabilidad, transporte, autenticación y replicación dependen de la
  implementación.
- `premise/1` no acepta silenciosamente `premise/0.1` ni `premise/2`; toda
  conversión debe ser explícita, validada y documentar la pérdida de campos.

La referencia normativa completa está en [`spec/premise-1/README.md`](../../spec/premise-1/README.md),
[`model.md`](../../spec/premise-1/model.md), [`states.md`](../../spec/premise-1/states.md),
[`decisions.md`](../../spec/premise-1/decisions.md) y
[`compatibility.md`](../../spec/premise-1/compatibility.md).
