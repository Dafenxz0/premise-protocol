# Contrato de evidencia para PREMiSE v2.0 GA

Esta carpeta define qué debe demostrar una release antes de llamarse
`v2.0.0 GA`. La fuente machine-readable es [`acceptance.json`](./acceptance.json).
Este README explica cómo interpretar sus gates, umbrales y artefactos; no
reemplaza las pruebas ni cambia el estado de aceptación.

## Estado actual

En la auditoría de esta rama, [`acceptance.json`](./acceptance.json) mantiene
`"status": "candidate"`. Eso significa que PREMiSE tiene una ruta técnica
seria hacia GA, pero todavía no existe un expediente completo que permita
presentarlo como una solución universal o como un servicio de producción sin
condiciones.

El estado no se puede elevar porque compile el código, porque los tests locales
pasen o porque un workflow de CI aparezca en verde. Cada gate necesita evidencia
reproducible, revisable y adecuada para la afirmación que se quiere publicar.

## Qué significa cada estado

- `candidate`: hay implementación, pruebas o evidencia en progreso, pero falta
  al menos una condición de salida.
- `implementation-checked`: los módulos y la estructura del contrato están
  presentes. Es el resultado de una comprobación de repositorio; no acredita
  una campaña real.
- `evidence-checked`: el comprobador encontró los artefactos declarados en un
  directorio de evidencia. No equivale a una revisión humana, a una
  reproducción independiente ni a una autorización de producción.
- `GA`: solo es publicable después de revisar el contenido, reproducir lo
  necesario y cerrar todos los bloqueos descritos en este contrato. No es un
  valor que deba escribirse para ocultar evidencia faltante.

## Gates y artefactos requeridos

Cada nombre es un contrato de entrega. Un archivo vacío, un resumen sin trazas
o un resultado de una fixture no satisface el gate.

| Gate | Evidencia requerida | Qué debe demostrar |
| --- | --- | --- |
| Conformidad del protocolo | `conformance-v2.json`, `replay-report.json` | Que los envelopes y eventos válidos cumplen el contrato v2 y que replay es determinista e idempotente. |
| Seguridad criptográfica | `security-report.json`, `threat-model.md` | Que las primitivas, límites, amenazas, permisos, auditoría y respuesta ante fallos están probados y revisados. |
| Persistencia real | `postgres-integration.json`, `backup-restore.json` | Que PostgreSQL real, migraciones, aislamiento por tenant, backup y restore funcionan en el entorno declarado. |
| Evaluación externa ciega | `external-holdout.json`, `dataset-manifest.json` | Que un holdout oculto, con hashes públicos y runner independiente, alcanza los umbrales de precisión y frescura. |
| Carga y recuperación | `load-full.json`, `recovery-report.json` | Que el perfil de referencia soporta la escala, concurrencia, reinicio, corrupción y recuperación declaradas. |
| Operación | `operations-smoke.json`, `rollback-report.json` | Que el despliegue es reproducible y que métricas, alertas, backup y rollback se observaron en una secuencia real. |
| Disponibilidad y coste | `soak-availability.json`, `cost-report.json` | Que un soak de duración suficiente cumple el SLO y que el coste procede de facturación o medición real, no solo de un modelo local. |
| API estable | `sdk-contract.json`, `openapi-validation.json` | Que SDK, OpenAPI, schemas, paginación, errores tipados y política de compatibilidad son utilizables por integradores. |

El listado anterior debe permanecer sincronizado con `acceptance.json`. Si falta
un artefacto, el resultado correcto es `candidate` o `blocked`, nunca `GA`.

## Requisitos mínimos de cada evidencia

Todo artefacto cuantitativo debe incluir, directamente o mediante referencias
con hash:

1. commit o versión exacta del producto y del runner;
2. versión del dataset, hash SHA-256 y reglas de construcción;
3. plataforma, hardware, versión de Node, dependencias y configuración;
4. seed, número de repeticiones, duración, tamaño de muestra y denominadores;
5. trazas crudas, errores, timeouts y tareas descartadas, sin eliminar outliers;
6. al menos un baseline comparable cuando se mida una mejora;
7. instrucciones para reproducirlo y una firma o digest que permita detectar
   sustituciones.

Los datos sensibles, tokens, contenido privado y secretos no se publican. La
redacción debe dejar claro qué se eliminó y conservar un digest del artefacto
original cuando sea posible. Un reporte Markdown por sí solo no sustituye al
JSON, las trazas ni los logs que lo respaldan.

## Política de verdad

- Las fixtures, los test doubles, los mocks y los resultados sintéticos son
  válidos para regresión y CI. No son evidencia externa de comportamiento en
  producción.
- Un benchmark debe fijar el workload antes de ejecutar, separar desarrollo de
  evaluación y evitar que el candidato reciba el oracle, la respuesta dorada o
  el split de holdout.
- La reproducción independiente debe ser realizada por una persona, runner o
  infraestructura que no haya ajustado el sistema mirando las respuestas del
  holdout. Compartir el hash del dataset protege la identidad del corpus; no
  convierte un dataset público en un holdout independiente.
- Una lectura real de GitHub en modo solo lectura prueba que el adapter puede
  observar ese endpoint bajo esas credenciales y condiciones. No prueba una
  mutación en vivo, una disponibilidad permanente, todos los permisos ni todos
  los conectores.
- Una prueba criptográfica prueba una propiedad de la primitiva y de su uso en
  el proceso. No demuestra custodia KMS/HSM, identidad, segregación operativa,
  durabilidad WORM ni cumplimiento normativo.

## Integridad de la campaña

El directorio de evidencia se considera inmutable para la decisión de release.
El proceso recomendado es:

1. congelar código, configuración, dataset y thresholds;
2. ejecutar las campañas sin editar los resultados;
3. conservar resultados, trazas, logs y hashes juntos;
4. repetir los gates que requieran independencia en otra ejecución o
   infraestructura;
5. revisar manualmente seguridad, privacidad, coste, rollback y claims;
6. etiquetar la release solo cuando todos los gates estén verdes.

`pnpm ga:gate` verifica principalmente la forma y la presencia de componentes.
`pnpm ga:gate:strict` requiere `PREMISE_GA_EVIDENCE_DIR`; encontrar nombres de
archivo no convierte automáticamente su contenido en evidencia válida.
Para reunir artefactos ya producidos sin inventar resultados se puede usar
`pnpm ga:evidence:collect -- --input DIR --output DIR`; los ficheros ausentes,
vacíos o incompatibles quedan reportados y bloquean el modo estricto.

La auditoría pública completa, con los umbrales, los bloqueos y la matriz de
claims permitidos, está en [`docs/ga-readiness.md`](../../docs/ga-readiness.md).
