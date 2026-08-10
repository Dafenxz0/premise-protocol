# GA Evaluation

Benchmark externo, versionado y ciego para comparar lectura directa, cache TTL,
retrieval sin protocolo y el comportamiento PREMiSE version-gated.

La ejecución siempre verifica primero los 12 datasets públicos fijados a commits
de GitHub y sus SHA-256. Si una descarga falla, cambia el hash o contiene una
referencia `fixture://`, la ejecución termina con código distinto de cero y no
emite resultados válidos.

```powershell
node benchmarks/ga-evaluation/runner.mjs --split all
node benchmarks/ga-evaluation/self-check.mjs
```

Salidas reproducibles de la última ejecución:

- `outputs/results.json`: metadatos de campaña, métricas y claims permitidos.
- `outputs/report.md`: reporte legible.
- `outputs/traces.jsonl`: una traza por tarea y estrategia; no contiene respuestas doradas.

Para conectar un sistema real, se puede pasar `--candidate "<comando>"`. El
proceso recibe una tarea sin `split`, `snapshot`, `oracle`, `expected` ni
`answer`; puede pedir evidencia con mensajes NDJSON `read` o `version` y termina
con `answer`. El runner conserva el oracle en el proceso padre y nunca devuelve
al candidato si acertó.

La especificación completa, los límites de interpretación y el protocolo están
en [`docs/ga-evaluation.md`](../../docs/ga-evaluation.md).
