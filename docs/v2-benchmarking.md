# Benchmarks v2 sin autoengaño

La suite se divide en dos porque una prueba reproducible y una prueba contra el mundo real responden preguntas distintas.

| Suite | Fuente | Qué demuestra | Qué no demuestra |
| --- | --- | --- | --- |
| `offline-temporal-fixture` | timeline determinista de 100 tareas | Propagación, invalidación y comparación con TTL bajo cambios conocidos | Rendimiento de GitHub ni calidad de un modelo |
| `live-github-readonly` | API de un repositorio real | Coste observable, latencia, ETag y exactitud frente a respuestas reales | Recuperación después de mutar un repositorio público |

Cada campaña publica números simples por 100 tareas: aciertos, peticiones, errores, p50 y p95. También conserva una traza por tarea. “Correcta” significa igualdad exacta con la respuesta de referencia del workload; no significa que PREMiSE haya descubierto una verdad universal.

## Baselines

- `direct-read`: vuelve a consultar la fuente en cada tarea.
- `ttl-cache-20`: cachea durante 20 tareas y muestra el coste de ignorar cambios.
- `premise-event-cache` o `premise-conditional-cache`: conserva el resultado hasta que una señal o una comprobación condicional obliga a refrescarlo.

La fixture debe seguir teniendo al menos un baseline que ahorre peticiones a costa de errores. Si PREMiSE “gana” todas las columnas sin pagar ningún coste, el benchmark está mal diseñado.

## Cómo convertir un número en promesa

No se debe prometer una cifra de producto desde una única ejecución local. El mínimo para una afirmación pública es: dataset y runner versionados, misma configuración de modelo/prompt cuando exista, orden aleatorio, varias semillas, intervalos de confianza, dos infraestructuras, trazas sin resumir, holdout oculto y reproducción independiente.
