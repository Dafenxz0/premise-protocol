# PREMiSE `premise/1`

Especificación normativa mínima para el contrato de validez de PREMiSE. Esta
carpeta es autocontenida: define el modelo, los estados, las decisiones, la
compatibilidad y los vectores de conformidad del identificador de protocolo
`premise/1`.

El plan PREMiSE v2 puede tener implementaciones y superficies adicionales,
pero una implementación que anuncie este contrato MUST cumplir lo que aquí se
define. La especificación no convierte PREMiSE en una memoria principal, un
buscador, una base vectorial ni un almacén del contenido.

## Entrada normativa

Las palabras **MUST**, **MUST NOT**, **SHOULD** y **MAY** son normativas.

| Archivo | Contenido |
| --- | --- |
| [`model.md`](./model.md) | Envelope, operaciones, eventos e invariantes del contrato. |
| [`contract.schema.json`](./contract.schema.json) | JSON Schema del envelope, operaciones, eventos y capacidades. |
| [`states.md`](./states.md) | Estados, transiciones, prioridades y propagación por dependencias. |
| [`decisions.md`](./decisions.md) | Decisiones portables de `check`: `USE`, `REVALIDATE` y `REJECT`. |
| [`compatibility.md`](./compatibility.md) | Perfil de compatibilidad y reglas de versionado/interoperabilidad. |
| [`compatibility.json`](./compatibility.json) | La misma política mínima en forma machine-readable. |
| [`test-vectors/`](./test-vectors/) | Vectores JSON deterministas de contrato y su manifiesto. |
| [`vectors/`](./vectors/) | Fixtures compactas de escenarios semánticos; usan proyecciones del runner y no sustituyen al schema wire. |

## Identidad del contrato

Todo envelope, operación, evento o declaración de capacidades MUST llevar
`"specVersion": "premise/1"`. El valor `premise/2` no es un alias: un
consumidor `premise/1` MUST rechazarlo salvo que un adaptador negociado lo
convierta y conserve la semántica.

El envelope mínimo es metadata, no contenido:

```json
{
  "specVersion": "premise/1",
  "tenantId": "tenant:example",
  "memoryId": "memory:example:42",
  "evidence": [
    {
      "evidenceId": "e:42",
      "sourceUri": "source://example/42",
      "observedAt": "2026-08-11T10:00:00Z",
      "version": { "scheme": "revision", "token": "r1" },
      "validator": { "id": "example", "operation": "read" }
    }
  ],
  "validity": {
    "status": "FRESH",
    "checkedAt": "2026-08-11T10:00:00Z",
    "policy": "VERSIONED"
  },
  "dependsOn": []
}
```

Una implementación compatible MUST conservar `memoryId`, evidence, versiones,
validators, `dependsOn` y la historia de eventos. No puede presentar
`INVALID` como información actual ni reparar una invalidación sin una nueva
observación explícita.

## Vectores

`test-vectors/manifest.json` es la entrada estable del corpus de contrato.
`vectors/manifest.json` contiene además escenarios compactos de estados y
decisiones. Ambos corpus usan datos deterministas y no dependen de la hora del
sistema. Un runner puede ejecutar cada vector de forma independiente; una
operación rechazada MUST dejar estado, grafo e historia sin cambios y producir
cero eventos.

Validación local mínima:

```powershell
node --input-type=module -e "import { readdir, readFile } from 'node:fs/promises'; const dir='spec/premise-1/test-vectors'; const files=(await readdir(dir)).filter((file)=>file.endsWith('.json')); for (const file of files) JSON.parse(await readFile(dir+'/'+file,'utf8')); console.log('premise/1 JSON OK ('+files.length+' files)')"
```

La comprobación JSON no sustituye a un runner de conformidad: los estados y
las decisiones esperadas están descritos de forma portable en cada vector.
