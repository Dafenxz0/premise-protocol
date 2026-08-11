# PREMiSE/1 — referencia TypeScript

Referencia Node/TypeScript autocontenida para la semántica mínima de
`premise/1`. No importa paquetes del monorepo ni implementa almacenamiento,
retrieval, embeddings o red.

Implementa las operaciones portables de los vectores JSON:

- `check`: evidencia versionada, dependencias, invalidación explícita,
  aislamiento por `tenant` y propagación conservadora.
- `revalidate`: `UNCHANGED` → `FRESH`, `CHANGED`/`MISSING` → `INVALID`,
  `UNKNOWN` → `UNKNOWN`.
- `replay`: cuenta operaciones nuevas, replays idempotentes y conflictos.
- `write`: rechaza el escape TOCTOU cuando cambia la versión observada.

Las decisiones son `USE`, `REVALIDATE` y `REJECT`. No se consulta el reloj ni
se generan identificadores aleatorios.

Uso:

```text
npm test
npm run vectors
node dist/cli.js path/to/vector.json
node dist/cli.js path/to/manifest.json
```

El manifest puede contener `vectors` como nombres de archivos relativos; un
archivo de vectores también puede contener `vectors` inline. El CLI emite una
línea JSON determinista con `{ "id", "output" }` por vector.
