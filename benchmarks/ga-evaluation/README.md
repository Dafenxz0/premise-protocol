# GA Evaluation

Benchmark versionado y ciego para comparar lectura directa, cache TTL, un
baseline de retrieval sin protocolo y el comportamiento PREMiSE version-gated.

La clasificación es deliberadamente explícita: `datasets/v1.json` fija fuentes
públicas reales por URL, commit y SHA-256 (`external-public-static`), mientras
que las métricas, latencias y ejecución del runner son evidencia local
(`local-runner`). Esta suite local no produce evidencia independiente ni un
resultado GA público; el holdout externo atestado es el camino separado para
esa afirmación.

La ejecución siempre verifica primero los 11 datasets públicos fijados a commits
de GitHub y sus SHA-256. Si una descarga falla, cambia el hash o contiene una
referencia `fixture://`, la ejecución termina con código distinto de cero y no
emite resultados válidos.

```powershell
node benchmarks/ga-evaluation/runner.mjs --split all
node benchmarks/ga-evaluation/self-check.mjs --require-output --require-external
```

Salidas reproducibles de la última ejecución:

- `outputs/results.json`: metadatos de campaña, métricas y claims permitidos.
- `outputs/report.md`: reporte legible.
- `outputs/traces.jsonl`: una traza por tarea y estrategia; no contiene respuestas doradas.

Los prompts y las labels están separados: `prompts/v1.json` solo contiene las
tareas que puede recibir un candidato; `labels/v1.json` conserva snapshots y
oráculos en el proceso evaluador. El aislamiento de proceso sigue siendo una
responsabilidad de la infraestructura: un candidato no confiable necesita un
sandbox del sistema operativo, porque este repositorio local no es una frontera
de seguridad.

La validación rechaza referencias `fixture:`, `synthetic:`, `mock:`, `fake:` y
`dummy:` en los manifiestos, exige `syntheticData: false` por dataset y falla
cerrado ante cualquier hash, separación o artefacto incompleto. Esto detecta
marcadores declarados; no prueba que el contenido público no haya sido escrito
artificialmente.

Para conectar un sistema real, se puede pasar `--candidate "<comando>"`. El
proceso recibe una tarea sin `split`, `snapshot`, `oracle`, `expected` ni
`answer`; puede pedir evidencia con mensajes NDJSON `read` o `version` y termina
con `answer`. El runner conserva el oracle en el proceso padre y nunca devuelve
al candidato si acertó.

La especificación completa, los límites de interpretación y el protocolo están
en [`docs/ga-evaluation.md`](../../docs/ga-evaluation.md).
