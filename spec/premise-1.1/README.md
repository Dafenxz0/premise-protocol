# PREMiSE `premise/1.1`

Especificación normativa mínima para coherencia causal de recursos. El
directorio es autocontenido: define el modelo, los estados, las decisiones,
la compatibilidad, el JSON Schema wire y los vectores manuales del perfil
`premise/1.1`.

Las palabras **MUST**, **MUST NOT**, **SHOULD** y **MAY** son normativas.

## Alcance

`premise/1.1` conserva solamente identidad, observaciones, dependencias,
precondiciones causales y resultados de aplicación. No transporta contenido,
no implementa retrieval y no decide la verdad externa de un `versionToken`.

El contrato es deliberadamente cerrado. Un consumidor MUST rechazar un campo
desconocido antes de aplicar una operación. La validación estructural usa
[`contract.schema.json`](./contract.schema.json); las igualdades entre
identificadores, el cierre causal y la frontera mínima se definen en
[`model.md`](./model.md), [`states.md`](./states.md) y
[`decisions.md`](./decisions.md).

## Entrada normativa

| Archivo | Contenido |
| --- | --- |
| [`model.md`](./model.md) | Identidad, observaciones, dependencias, change sets, receipts, snapshots y Premise Sets. |
| [`contract.schema.json`](./contract.schema.json) | Esquema JSON cerrado para los documentos wire. |
| [`states.md`](./states.md) | Estados y transiciones atómicas. |
| [`decisions.md`](./decisions.md) | Coherencia, decisiones y algoritmo de frontera mínima. |
| [`compatibility.md`](./compatibility.md) | Perfil obligatorio y adaptación desde otros contratos. |
| [`test-vectors/manifest.json`](./test-vectors/manifest.json) | Entrada estable del corpus de vectores authored-by-hand. |

## Perfil mínimo

Una implementación que anuncie `PREMiSE-compatible premise/1.1` MUST soportar
`OBSERVATION`, `PREMISE_SET`, `CHANGE_SET`, `RECEIPT`, `TENANCY` y `FRONTIER`.
Debe conservar el tenant en cada referencia, tratar el snapshot causal como
precondición exacta y devolver el mismo receipt en un replay idempotente.

`premise/1.1` no es un alias de `premise/1` ni de `premise/2`. El campo
`specVersion` debe ser exactamente `premise/1.1`; cualquier adaptación requiere
negociación explícita y debe documentar la pérdida de semántica.

## Vectores

Los ficheros de `test-vectors/` están escritos a mano y no se generan desde una
implementación. Cada vector es independiente, usa reloj manual y compara
arrays ordenados. El campo `input` contiene una operación wire; `expect` es la
proyección portable del runner:

- `apply` compara `APPLIED`/`REJECTED`, el estado de recursos y el receipt;
- un retry con la misma clave y digest tiene disposición `REPLAY` y debe ser
  byte-a-byte igual al receipt indicado por `receiptSameAs`;
- una clave reutilizada con otro digest tiene disposición `CONFLICT`, no crea
  receipt nuevo y no muta el estado;
- `check` compara `coherence`, `decision`, `frontier` y `reason`;
- una operación rechazada MUST dejar estado y receipts previos sin cambios.

La frontera esperada se ordena por `(tenantId, resourceId)` y sus elementos son
las referencias de los miembros que deben volver a observarse. La comparación
de objetos ignora el orden de claves; la comparación de arrays es significativa.

Comprobación local mínima, sin dependencias nuevas:

```powershell
node --input-type=module -e "import { readdir, readFile } from 'node:fs/promises'; const dir='spec/premise-1.1/test-vectors'; const files=(await readdir(dir)).filter((file)=>file.endsWith('.json')); for (const file of files) JSON.parse(await readFile(dir+'/'+file,'utf8')); JSON.parse(await readFile('spec/premise-1.1/contract.schema.json','utf8')); console.log('premise/1.1 JSON OK ('+files.length+' vector files)')"
```
