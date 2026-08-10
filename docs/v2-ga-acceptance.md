# PREMiSE v2.0 GA: criterios de aceptación

PREMiSE v2.0 GA no se declara porque el código compile o porque el CI pase. Se declara únicamente cuando existe evidencia reproducible de cada gate de [`spec/ga/acceptance.json`](../spec/ga/acceptance.json).

## Qué significa “GA”

GA significa que una organización puede desplegar PREMiSE con un procedimiento repetible, medirlo, recuperar sus datos y entender sus límites. No significa que el protocolo sea una autoridad universal sobre la verdad ni que sustituya una base de datos, un índice vectorial o un proveedor de modelos.

## Umbrales públicos

| Medida | Umbral mínimo para GA | Cómo se demuestra |
|---|---:|---|
| Exactitud en holdout externo | ≥ 95% | Dataset oculto, hash público y runner independiente |
| Frescura dentro del SLA | ≥ 99% | Mutaciones temporales y trazas por tarea |
| Latencia p95 | ≤ 500 ms | Perfil de referencia declarado |
| Latencia p99 | ≤ 2.000 ms | Misma campaña, sin ocultar outliers |
| Tasa de error | ≤ 0,1% | Carga sostenida y recuperación |
| Disponibilidad | ≥ 99,9% | Soak test con health checks y alertas |
| Coste | ≤ 0,05 USD / 1.000 operaciones | Coste de infraestructura documentado, no una estimación inventada |

Los umbrales son criterios de salida, no resultados actuales. Una cifra de un fixture local nunca se puede presentar como evidencia externa.

## Reglas de evidencia

Cada resultado GA debe conservar:

- versión exacta del commit y del dataset;
- hardware, versión de Node, configuración y número de repeticiones;
- trazas crudas, errores y tareas descartadas;
- comparación con al menos un baseline sin PREMiSE;
- reproducción independiente o una explicación explícita de por qué aún no es posible.

Si falta un artefacto, el estado correcto es `candidate` o `blocked`, nunca `GA`. El script `scripts/ga-gate.mjs` comprueba la presencia y la forma de estos artefactos; no convierte automáticamente resultados incompletos en una promesa.

## Proceso de liberación

1. Ejecutar las campañas visibles y generar hashes.
2. Congelar el holdout sin entregarlo al sistema evaluado.
3. Ejecutar persistencia, carga, recuperación y despliegue en una infraestructura declarada.
4. Guardar los artefactos en un directorio de evidencia inmutable.
5. Ejecutar `pnpm ga:gate --strict`.
6. Revisar manualmente seguridad, privacidad, coste y rollback.
7. Etiquetar `v2.0.0` solo si todos los gates están verdes.
