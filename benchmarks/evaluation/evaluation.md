# Auditoría de evaluación PREMiSE

Generado: 2026-08-10T10:39:34.242Z

## Conclusión

- Estado de validez de v0.1: **PROVISIONALLY-VALID**.
- Ejecución actual: disponible; 40 escenarios, 40 trazas, 10 controles y 5 ablations.
- Comparativas externas: comparative-bench=present, long-context-bench=present, real-world-bench=present, context-corpus-bench=present.
- La evaluación no convierte una métrica aislada en una victoria universal: primero exige seguridad, luego recuperación y finalmente coste.
- La campaña paired ya exporta decisiones por episodio y compara PREMiSE con un baseline sin protocolo y con perfiles de contexto largo.
- `real-world-bench` y `context-corpus-bench` se reportan por separado: sus métricas no se agregan a los denominadores de v0.1 ni entre sí.

## Comandos reproducibles

```text
node benchmarks/premise-memory-bench/test/benchmark.test.mjs
pnpm benchmark:real-world
pnpm benchmark:context-corpus
node benchmarks/evaluation/runner.mjs
node benchmarks/evaluation/runner.mjs --compare-to benchmarks/evaluation/evaluation.json
```

Los artefactos se escriben en benchmarks/evaluation/: v01-current.json, evaluation.json y evaluation.md.

## Qué significa «mejor»

La unidad de análisis es el episodio emparejado por `episodeId`; cada estrategia recibe el mismo episodio y el mismo oráculo. La evaluación no colapsa las dimensiones en una sola victoria:

| Dimensión | Métrica | Dirección | Gate inicial |
| --- | --- | --- | --- |
| Seguridad de acciones | `unsafeActionRate`, `actionSafetyRate` | menor / mayor | 0% de uso inseguro |
| Recuperación posible | `recoveryRate` | mayor | ≥95% cuando n≥10 |
| No reparable/desconocido | `nonRepairableRejectRate` | mayor | 100% de rechazo seguro |
| Coste de relectura | llamadas por episodio y por éxito | menor | +10% o +0.10 llamadas |
| Latencia | p50/p95 por episodio | menor | +20% y +50 ms |
| Memoria | p50/p95 bytes o tokens | menor | +15% y +4 KiB |
| Historial | preservación semántica | mayor | no caer >2 pp |
| Falsos rechazos | rechazo en controles frescos | menor | +2 pp; controles 100% |

Latencia y memoria quedan como `null` cuando no hay instrumentación. Un `REJECT` seguro en un caso no reparable no se cuenta como éxito de tarea: seguridad y utilidad se reportan por separado.

## Resultados v0.1 disponibles

| Baseline | stale recall | stale action | repair agregado | task success | relecturas | historial |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Plain Memory | 100.0% | 100.0% | 0.0% | 0.0% | 0 | 100.0% |
| Prompt Recheck | 100.0% | 0.0% | 70.0% | 70.0% | 40 | 100.0% |
| TTL Memory | 100.0% | 100.0% | 0.0% | 0.0% | 0 | 100.0% |
| Always Refresh | 100.0% | 0.0% | 70.0% | 70.0% | 40 | 100.0% |
| PREMiSE Explicit | 100.0% | 0.0% | 47.5% | 47.5% | 20 | 100.0% |

Estos son los números que el benchmark histórico imprime junto con su `decisionTrace`; la comparación más directa y estricta está en `benchmarks/comparative-bench/results.json`.

## Auditoría de validez

| Check | Estado | Evidencia |
| --- | --- | --- |
| expected-labels-consumed | pass | definitionFor conserva las expectativas del escenario |
| repair-is-observed | pass | La reparación aparece como evento observable |
| reread-is-instrumented | pass | Las relecturas están instrumentadas |
| controls-derive-observations | pass | Los controles derivan falseSuppression de decisiones |
| ablations-are-behavioral | pass | Las ablations ejecutan variantes independientes |
| latency-instrumentation | pass | Existe algún campo de latencia |
| memory-instrumentation | pass | Existe algún contador de memoria |
| history-fidelity | pass | La historia se valida semánticamente |
| episode-decisions-exported | pass | El resultado exporta decisiones por episodio |
| reopen-changes-observation | pass | Reabrir cambia la observación |
| format-and-counts | pass | Formato y cardinalidades declaradas |
| paired-episode-coverage | pass | Cada episodio del catálogo tiene exactamente una traza |
| oracle-label-agreement | pass | Las etiquetas expected coinciden con changeStatus |
| repairability-agreement | pass | repairPossible coincide con el oráculo conservador |
| repair-transition-evidence | pass | Las reparaciones prometidas tienen evidencia |
| non-repairable-cases | pass | Hay 12 episodios que deben rechazar o permanecer desconocidos |
| static-controls | pass | 10 controles estáticos reportan passed=true |
| ablation-execution | pass | Las ablations tienen resultado, pero deben ser variantes ejecutadas |
| baseline-paired-decisions | pass | Cada estrategia exporta una decisión auditable por episodio |
| latency-and-memory | pass | Latencia y metadata serializada están instrumentadas |
| history-evidence | pass | historyPreservationRate existe, pero su evidencia semántica es débil |

Denominadores del oráculo: 28 reparables, 12 no reparables/desconocidos, 17 con reparación explícita esperada, de 40 episodios.

Caveats que permanecen explícitos:

- La memoria medida en v0.1 es metadata serializada; el benchmark de contexto largo añade también un muestreo de heap de proceso.
- Los perfiles largos son mediciones locales de Node 24 y deben repetirse en el hardware objetivo antes de usarse como SLA.
- Los escenarios GitHub-like siguen siendo mundos deterministas locales; no sustituyen un adapter real conectado a GitHub.
- `real-world-bench` y `context-corpus-bench` son fuentes opcionales; si están presentes, el auditor conserva sus métricas y denominadores por fila sin combinarlos.

## Comparación paired por episodio (oráculo conservador)

Esta tabla conserva el oráculo conservador para comparar estrategias con el mismo denominador. Las trazas ejecutables y los benchmarks de escala están en los artefactos externos enlazados abajo.

| Baseline | seguridad | recuperación | rechazo no reparable | falsos rechazos | relecturas/episodio | historial |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Plain Memory | 0.0% | 0.0% | 0.0% | 0.0% | 0.00 | 100.0% |
| Prompt Recheck | 100.0% | 100.0% | 100.0% | 0.0% | 1.00 | 100.0% |
| TTL Memory | 0.0% | 0.0% | 0.0% | 0.0% | 0.00 | 100.0% |
| Always Refresh | 100.0% | 100.0% | 100.0% | 0.0% | 1.00 | 100.0% |
| PREMiSE Explicit | 100.0% | 100.0% | 100.0% | 0.0% | 0.70 | 100.0% |

La decisión de producto debe aplicar primero el gate de seguridad y después optimizar recuperación/coste. No se debe rankear una estrategia que usa memoria inválida aunque tenga menor latencia.

## Fuentes externas

- **comparative-bench**: present; 1 ficheros, 51 filas métricas reconocidas
  - Métricas reconocidas: `historyPreservationRate`, `latencyP50Ms`, `latencyP95Ms`, `memoryP50Bytes`, `memoryP95Bytes`, `recoveryRate`, `revalidationCalls`, `unsafeActionRate`.
  - Denominadores observados por fila (sin combinar): `episodes`, `dynamic`, `repairable`, `guarded`, `controls`.
- **long-context-bench**: present; 1 ficheros, 7 filas métricas reconocidas
  - Métricas reconocidas: `checkMs`, `deriveMs`, `externalPayloadBytes`, `heapDeltaBytes`, `latencyP50Ms`, `latencyP95Ms`, `registerMs`, `serializedMetadataBytes`, `signalMs`, `totalMs`, `validateMs`.
  - Denominadores observados por fila (sin combinar): `count`, `nodes`.
- **real-world-bench**: present; 1 ficheros, 133 filas métricas reconocidas
  - Métricas reconocidas: `averageTargetEvents`, `correctDecisionRate`, `episodesWithHistory`, `falseRejectionRate`, `memoryReadCalls`, `p50`, `p95`, `preservationRate`, `protocolValidateCalls`, `resultMatchRate`, `safeRecoveryRate`, `totalTargetEvents`, `unsafeActionRate`, `validateCalls`, `validatedRecoveryRate`, `versionForCalls`.
  - Denominadores observados por fila (sin combinar): `scenarios`, `episodes`, `safeToUse`, `unsafeToUse`, `recoveryCandidates`, `validationCases`, `isolationCases`, `cases`, `total`.
- **context-corpus-bench**: present; 1 ficheros, 100 filas métricas reconocidas
  - Métricas reconocidas: `externalPayloadBytes`, `falseRejectRate`, `precision`, `retrievalHitRate`, `safety`, `serializedMetadataBytes`, `totalMs`.
  - Denominadores observados por fila (sin combinar): `nodes`, `count`, `queries`, `total`.

El runner descubre `comparative-bench`, `long-context-bench`, `real-world-bench` y `context-corpus-bench`, guarda hashes, parsea filas métricas reconocibles y conserva los casos no reconocidos como limitación. No mezcla denominadores automáticamente.

## Umbrales de regresión

Los umbrales están en `evaluation.json` y se aplican al pasar `--compare-to`:

- seguridad: no aumentar `unsafeActionRate` más de 0.5 pp y nunca introducir uso inseguro en un caso protegido;
- recuperación: no caer más de 5 pp;
- falsos rechazos: no aumentar más de 2 pp y mantener controles estáticos al 100%;
- relecturas: no aumentar más de 10% ni 0.10 llamadas por episodio;
- latencia/memoria: no aumentar más de 20%/15% ni 50 ms/4 KiB;
- historial: no caer más de 2 pp.

Gate de esta ejecución: **not_run** (Pasa --compare-to <evaluation.json> para ejecutar el gate contra una ejecución anterior.).

## Prioridad de siguientes experimentos

1. **P0 — Repetir en hardware objetivo**: capturar latencia, heap y coste de revalidación con el mismo Node 24 y límites de despliegue.
2. **P0 — Contextos de payload real**: añadir tamaños de contenido externo y medir retrieval/adaptador sin contaminar el sidecar de metadata.
3. **P1 — Validators reales**: conectar filesystem/Git/GitHub cuando exista el adapter, manteniendo los mundos deterministas como control.
4. **P1 — Grafos dinámicos**: medir updates parciales, subgrafos solapados, reemplazos e invalidación concurrente.
5. **P2 — Gate de regresión**: guardar una ejecución aceptada y ejecutar `--compare-to` en CI para bloquear pérdidas de seguridad o escalabilidad.
