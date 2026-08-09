# Real-world integration benchmark

Benchmark aplicado y offline de `ReferenceProtocol` con los validators compilados reales:

- archivos temporales validados por `packages/validator-filesystem/dist`;
- repositorios Git temporales con commits validados por `packages/validator-git/dist`;
- 14 escenarios paired: baseline sin protocolo y PREMiSE;
- cambios de contenido, eliminación, cambio no relacionado, `SourceChanged` falso y dependencias derivadas;
- seguridad, falsos rechazos, recuperación validada, llamadas de validator, p50/p95, historial y aislamiento.

Ejecutar desde la raíz con Node 24:

```powershell
fnm env --shell powershell | Out-String | Invoke-Expression
fnm use 24
node benchmarks/real-world-bench/runner.mjs
node benchmarks/real-world-bench/self-check.mjs
```

`runner.mjs` escribe `results.json`. Cada ejecución crea fixtures temporales reales y los elimina al terminar; no usa red ni dependencias nuevas. La latencia mide el camino de decisión después de la mutación y excluye la creación del fixture.
