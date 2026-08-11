# PremiseBench-Agent: campaña real

Esta carpeta contiene el contrato congelado de una campaña contra dos
repositorios públicos del propietario del workspace: `healthcheck` y
`skillproof`. Los clones de trabajo viven fuera del árbol versionado, bajo
`.tmp/real-benchmark/`, y se usan en modo lectura.

La campaña compara tres estrategias de memoria con las mismas tareas y las
mismas herramientas:

1. memoria básica;
2. memoria mejorada convencional;
3. PREMiSE.

Los resultados brutos se escriben en
`benchmarks/premisebench-agent/artifacts/real-campaign/`, que está ignorado.
El examinador ciego recibe únicamente IDs aleatorios y trazas sin el nombre de
la estrategia. La asignación de IDs se conserva fuera del informe ciego hasta
que se cierra la evaluación.

`manifest.json` contiene tareas, métricas, commits y reglas de exclusión, pero
no contiene objetivos dorados, etiquetas de calidad ni respuestas esperadas.
El oráculo del control determinista vive únicamente en el runner local ignorado
y nunca se entrega al agente. En una campaña de agentes, el evaluador debe
recibir la salida después de cerrar la fase ciega; guardar el oráculo junto al
manifiesto público no es evidencia de aislamiento.

La campaña de clones es un control determinista sobre contenido real fijado en
commits concretos: sus `requests` son operaciones instrumentadas locales, no
llamadas de red ni coste monetario. El piloto ejecutado con agentes Luna Max se
publica por separado y no se mezcla con estas rondas: tiene otro conjunto de
tareas, telemetría de tokens desconocida y no incluye una mutación TOCTOU.
