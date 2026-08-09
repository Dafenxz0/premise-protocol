# Benchmarking de la siguiente versión

## Estado actual

La campaña de evaluación ya está ejecutable y deja separadas tres preguntas:

1. ¿Es seguro usar una memoria cuando su fuente ha cambiado?
2. ¿Puede el protocolo recuperar los casos reparables sin perder el historial?
3. ¿Qué coste tiene mantener el grafo y revalidarlo cuando crece el contexto?

La auditoría de v0.1 es `PROVISIONALLY-VALID`: tiene decisiones por episodio, relecturas, reparaciones observables, latencia, metadata serializada, controles y ablations. No se presenta como una prueba universal de producción porque los adapters externos y el hardware real todavía deben medirse por separado.

La evidencia aplicada está separada en dos campañas adicionales:

- `real-world-bench` usa archivos temporales y repositorios Git con commits reales, además de `FilesystemValidator` y `GitValidator` compilados desde este repositorio.
- `context-corpus-bench` crea un corpus de documentos en disco, un índice invertido y grafos de 1.000, 10.000 y 50.000 nodos; mide retrieval, decisiones, revalidación, metadata, heap y propagación selectiva.

Ambas campañas tienen un `self-check` que falla si aparece una acción insegura, un falso rechazo, una revalidación incorrecta, una pérdida de aislamiento o un payload de documento dentro del protocolo.

## Cómo reproducirlo

Desde la raíz del repositorio:

```text
pnpm benchmark:compare
pnpm benchmark:context:full
pnpm benchmark:evaluate
pnpm benchmark:next
pnpm benchmark:production
```

`benchmark:compare` ejecuta los mismos 24 episodios con y sin protocolo. `benchmark:context:full` mide grafos chain, fanout y shared-support en 1.000, 5.000, 10.000 y 25.000 nodos. `benchmark:evaluate` audita el benchmark histórico y escribe `benchmarks/evaluation/`. El comando `benchmark:next` ejecuta la campaña completa.

Para comparar una ejecución con otra:

```text
node benchmarks/evaluation/runner.mjs --compare-to benchmarks/evaluation/evaluation.json
```

## Criterio de comparación

La unidad es un episodio emparejado: cada estrategia recibe el mismo escenario, estado inicial, cambio y oráculo. El oráculo distingue:

- `FRESH`: se puede usar la memoria.
- `STALE` reparable: primero hay que validar la fuente.
- `INVALID` o `UNKNOWN`: hay que bloquear el uso.

El orden de decisión es deliberado: primero seguridad, después recuperación y finalmente coste. Una estrategia no puede ganar por ser rápida si usa memoria inválida.

Se registran `unsafeActionRate`, recuperación de casos reparables, rechazo de casos no reparables, relecturas, p50/p95 de latencia, p50/p95 de metadata, historial y falsos rechazos en controles frescos.

## Resultados de la campaña actual

- En 21 episodios con cambio, el baseline sin protocolo usa memoria no comprobada en el 100% de los casos.
- PREMiSE registra 0% de acciones inseguras, recupera el 100% de los episodios reparables y rechaza el 100% de los no reparables del conjunto paired.
- En la medición local de 25.000 nodos, la cadena pasó de aproximadamente 64 segundos a aproximadamente 0,23 segundos tras evitar comprobaciones de ciclos innecesarias al crear nodos nuevos.
- En el corpus aplicado, los tres patrones mantienen 100% de precisión, seguridad, ausencia de falsos rechazos y hit-rate hasta 100.000 nodos; el camino de protocolo/query queda en 2,8–3,6 segundos por patrón, separado de los 64,8 segundos de generación de los 100.000 documentos.
- Las señales se propagan solo por el subgrafo afectado; una rama independiente permanece fresca.

Estos números son evidencia reproducible del conjunto definido, no un SLA. Hay que repetirlos en el hardware de despliegue y con payloads reales.

## Siguientes experimentos

1. Repetir la campaña en hardware objetivo con límites de memoria y CPU fijados.
2. Añadir retrieval/adapters reales y medir por separado el contenido externo del sidecar de metadata.
3. Conectar un validator remoto de GitHub cuando esté disponible, conservando filesystem/Git y los mundos deterministas como controles.
4. Medir reemplazos, subgrafos solapados y actualizaciones concurrentes.
5. Guardar una ejecución aceptada en CI y bloquear regresiones de seguridad, recuperación o escala con `--compare-to`.

Los artefactos detallados están en `benchmarks/comparative-bench/`, `benchmarks/long-context-bench/` y `benchmarks/evaluation/`.
