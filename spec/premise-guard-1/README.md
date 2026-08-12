# PREMiSE Guard `premise-guard/1`

Contrato autocontenido para proteger una acción con estado PREMiSE validado.
La carpeta no cambia el runtime, la política ni el contrato `premise/1`: fija
la frontera entre validar una acción y comprometerla.

## Entrada normativa

Las palabras **MUST**, **MUST NOT**, **SHOULD** y **MAY** son normativas.

| Archivo | Contenido |
| --- | --- |
| [`contract.md`](./contract.md) | Semántica normativa de intents, receipts, slices, CAS, idempotencia y fencing. |
| [`contract.schema.json`](./contract.schema.json) | JSON Schema Draft 2020-12 de los mensajes wire. |
| [`vectors/`](./vectors/) | Vectores deterministas de conformidad y su manifiesto. |

## Qué protege

`premise-guard/1` protege una acción con efectos laterales. Un `GuardIntent`
describe exactamente qué acción y qué memorias se quieren usar. La validación
produce un `GuardReceipt` solo si el *action-critical slice* está completo y
su decisión es `USE`. El adapter debe presentar ese receipt en un
`ConditionalAction` y aplicar la acción únicamente dentro de una operación
atómica de compare-and-set (CAS).

La secuencia normativa es:

```text
GuardIntent
    │ validar roots + dependencias + fuentes + recursos
    ▼
GuardReceipt (slice completo, lease y fence token)
    │ CAS de todo el slice + lease + idempotency key
    ├── APPLIED
    ├── REPLAY
    └── REJECTED (sin efecto)
```

Una lectura `FRESH` o un receipt válido no autorizan por sí solos una escritura
incondicional. Si el adapter no puede hacer CAS atómico, debe fallar cerrado:
`CAS_REQUIRED`, sin ejecutar la acción.

## Validación local mínima

El corpus no depende de la hora del sistema ni de red. Como comprobación
estructural mínima:

```powershell
node --input-type=module -e "import { readdir, readFile } from 'node:fs/promises'; const dir='spec/premise-guard-1/vectors'; const files=(await readdir(dir)).filter((file)=>file.endsWith('.json')); for (const file of files) JSON.parse(await readFile(dir+'/'+file,'utf8')); console.log('premise-guard/1 JSON OK ('+files.length+' files)')"
```

Parsear JSON no sustituye a un runner de conformidad. Cada vector describe la
transición portable y los efectos esperados.

Los vectores son proyecciones semánticas: `validate`, `mutate_source`,
`mutate_memory`, `delete_recreate`, `advance_time` y `commit` son vocabulario
del harness, no endpoints wire. Los mensajes enviados por un adapter siguen
siendo los definidos en `contract.schema.json`.
