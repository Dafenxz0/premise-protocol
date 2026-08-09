# Context corpus benchmark

Benchmark offline de contextos grandes con un corpus temporal de documentos externos, un índice invertido y consultas deterministas. Cada nodo tiene un envelope PREMiSE con URI, versión SHA-256 y metadatos; el cuerpo del documento nunca se guarda en `ReferenceProtocol`.

El workload ejecuta tres patrones de dependencia (`chain`, `fanout`, `shared`), cambia selectivamente tres documentos, propaga `SourceChanged`, comprueba el estado antes/después, revalida mediante el `FilesystemValidator` real y reemplaza las memorias mutadas más una conclusión derivada representativa. `ReferenceProtocol` recomputa la clausura afectada durante esos reemplazos, evitando una reparación cuadrática. También comprueba una rama no relacionada.

Perfiles por defecto: `1k`, `10k` y `50k` nodos. `100k` es opcional porque depende del tiempo y memoria de la máquina.

```powershell
fnm exec --using v24.19.0 node benchmarks/context-corpus-bench/runner.mjs
fnm exec --using v24.19.0 node benchmarks/context-corpus-bench/self-check.mjs
```

Opcional:

```powershell
fnm exec --using v24.19.0 node benchmarks/context-corpus-bench/runner.mjs --include-100k --max-ms 600000
```

`results.json` incluye precisión, safety, false-reject-rate, retrieval-hit-rate, latencias p50/p95 de operaciones y consultas, bytes de metadata, heap, propagación y evidencia de validación `filesystem`. Las cifras de latencia/heap son mediciones locales; el seed, corpus, consultas y cambios son deterministas. El runner limpia el corpus temporal al terminar.
