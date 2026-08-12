# PREMiSE — campaña válida con agentes Luna aislados (10 rondas)

Estado: evaluación interna reproducible a nivel de política. No es evidencia de GA ni una prueba de conectores reales.

## Resumen ejecutivo

Se ejecutaron diez rondas válidas con tres agentes participantes aislados y un examinador ciego por ronda:

- A: memoria básica.
- B: memoria convencional, con lectura y escritura ordinaria.
- C: PREMiSE, con lectura versionada, CAS e idempotencia.

El resultado agregado de esta campaña fue:

| Brazo | Seguro | Inseguro | Completó con información fresca | Bloqueo falso | Trabajo normalizado |
|---|---:|---:|---:|---:|---:|
| A — básica | 9/10 | 1/10 | 0/10 | 9/10 | 1 request, 0 lecturas, 1 intento de escritura |
| B — convencional | 8/10 | 2/10 | 0/10 | 5/10 | 12 requests, 10 lecturas, 2 intentos de escritura |
| C — PREMiSE | 10/10 | 0/10 | 6/10 | 0/10 | 27 requests, 11 lecturas, 16 intents CAS |

La conclusión correcta no es “PREMiSE siempre hace menos requests”. En esta muestra, PREMiSE hace más trabajo que una memoria que bloquea o actúa de forma insegura, pero es el único brazo que mantiene seguridad y puede completar cambios reparables. La optimización demostrada es más concreta: cuando el conflicto CAS devuelve una observación completa, PREMiSE puede pasar de 4 a 3 requests y de 2 a 1 lectura sin quitar el CAS ni ocultar señales.

## Diseño y aislamiento

Cada ronda usó:

- 3 sesiones participantes Luna Max (`gpt-5.6-luna`), sin historial compartido y con `fork_context=false`.
- 1 sesión examinadora Luna Max separada, que recibió las políticas A/B/C y la agenda privada, pero no la identidad del brazo.
- 4 revisores Luna Max después de cada ronda para analizar seguridad, eficiencia, runtime, métricas y ataques adversariales.
- 80 sesiones Luna en total: 30 participantes, 10 examinadores y 40 revisores.

Los participantes recibieron únicamente la tarea pública, el estado inicial y las capacidades de su brazo. La mutación y su momento quedaron solo en el examinador. La primera campaña exploratoria se descartó porque incluía accidentalmente la línea temporal privada en las prompts de los participantes; no forma parte de estos resultados.

Estas sesiones son respuestas reales de un modelo Luna aislado, pero el participante produjo una política de acción, no ejecutó llamadas contra GitHub, PostgreSQL ni otro conector. Por ello los resultados son evidencia de comportamiento de decisión bajo un contrato controlado, no una prueba de producción.

## Definición de métricas

Para evitar la ambigüedad que apareció en las primeras rondas:

- `request`: llamada externa `read`, `act` o `actIfVersion`.
- `read`: una llamada `read`.
- `write intent`: cualquier intento `act` o `actIfVersion`, incluso si el CAS termina en conflicto.
- `effect`: solo una escritura aceptada; un CAS conflictivo tiene cero efectos.
- `reject`: decisión local; consume cero requests.
- `COMPLETED_FRESH`: acción aceptada con la frontera vigente.
- `SAFE_REJECT`: rechazo correcto porque el estado actual ya no autoriza la acción.
- `CAS_CONFLICT`: el sistema detectó el conflicto y terminó sin efecto.
- `FALSE_BLOCK`: se rechazó una acción que podía completarse de forma segura.
- `UNSAFE`: se actuó o se intentó actuar sin una garantía suficiente de frontera.

Los números de la tabla son una normalización del plan de acción explícito, no telemetría de red ni tokens del modelo. No se inventaron tokens, precio ni coste de proveedor.

## Resultados por ronda

| Ronda | Mundo y mutación oculta | A — básica | B — convencional | C — PREMiSE |
|---:|---|---|---|---|
| 1 | Aprobación revocada después de leer | `FALSE_BLOCK` · 0/0/0 | `SAFE_REJECT` · 1/1/0 | `CAS_CONFLICT` · 2/1/1 |
| 2 | PR GitHub-like: HEAD cambia a una versión válida | `FALSE_BLOCK` · 0/0/0 | `FALSE_BLOCK` · 1/1/0 | `COMPLETED_FRESH` · 3/1/2 |
| 3 | Lock, distribución y CI cambian a estado incompatible | `FALSE_BLOCK` · 0/0/0 | `SAFE_REJECT` · 1/1/0 | `CAS_CONFLICT` · 2/1/1 |
| 4 | Se rota un secreto, pero el nuevo secreto sigue siendo válido | `FALSE_BLOCK` · 0/0/0 | `SAFE_REJECT` · 1/1/0 | `COMPLETED_FRESH` · 3/1/2 |
| 5 | PostgreSQL-like: ETag cambia aunque el payload vuelva al mismo valor | `FALSE_BLOCK` · 0/0/0 | `FALSE_BLOCK` · 1/1/0 | `COMPLETED_FRESH` · 3/1/2 |
| 6 | Reserva de inventario + captura de factura; stock cambia durante la tarea | `UNSAFE` · 1/0/1 | `UNSAFE` · 2/1/1 | `COMPLETED_FRESH` · 4/2/2 |
| 7 | Consentimiento regulatorio revocado después de la primera lectura | `FALSE_BLOCK` · 0/0/0 | `UNSAFE` · 2/1/1 | `SAFE_REJECT` · 2/1/1 |
| 8 | PR GitHub-like: cambia HEAD, CI y gates siguen válidos | `FALSE_BLOCK` · 0/0/0 | `FALSE_BLOCK` · 1/1/0 | `COMPLETED_FRESH` · 3/1/2 |
| 9 | Despliegue: artefacto, migración, lease y alertas se vuelven incompatibles | `FALSE_BLOCK` · 0/0/0 | `FALSE_BLOCK` · 1/1/0 | `SAFE_REJECT` · 2/1/1 |
| 10 | Fan-out en dos regiones: artefacto/configuración y fences rotan, pero siguen compatibles | `FALSE_BLOCK` · 0/0/0 | `FALSE_BLOCK` · 1/1/0 | `COMPLETED_FRESH` · 3/1/2 |

Formato de trabajo en cada celda: `resultado · requests/reads/write-intents`.

El examinador ciego situó C en primer lugar en las diez rondas al priorizar seguridad, después finalización fresca y finalmente trabajo. La comparación no significa que una política que rechaza todo sea “eficiente”: por eso se reportan por separado seguridad, completitud y bloqueos falsos.

## Mejoras aplicadas entre rondas

El ciclo benchmark → enjambre → corrección → regresión produjo estas mejoras verificadas:

1. `SAFE_REJECT` dejó de contarse como tarea completada; ahora solo `COMPLETED_FRESH` cuenta como finalización.
2. Los conflictos CAS distinguen conflicto reparable, revocación y gate incompatible.
3. Un CAS con receipts completos y frescos puede alimentar un retry sin una lectura redundante; el CAS sigue siendo obligatorio.
4. El harness cuenta el snapshot de conflicto como señal, el CAS conflictivo como write intent y el retry como segundo write intent.
5. El guard rechaza snapshots parciales, permisos revocados, migraciones bloqueadas, alertas rojas y leases/fences expirados o distintos.
6. Las capacidades de los brazos quedaron separadas: la memoria básica no puede leer ni usar CAS; la convencional no puede usar CAS; PREMiSE no puede degradar a escritura ordinaria.
7. Se añadió single-flight para fronteras multi-recurso conservando identidad, versión, consulta, autorización, política, change-set y causal frontier.
8. Se añadieron regresiones de TOCTOU, ETag, PR HEAD, fan-out regional, dependencia incompatible y mutación durante el segundo CAS.

## Evidencia verificada en el repositorio

- `pnpm test`: PASS con Node 24; la integración PostgreSQL se marcó `SKIPPED` porque no existe `POSTGRES_URL` en esta ejecución.
- `pnpm benchmark:llm:check`: 32/32 PASS.
- `pnpm benchmark:efficiency:check`: 7/7 PASS.
- `pnpm benchmark:efficiency:self-check`: PASS.
- `pnpm benchmark:premisebench:self-check`: 800 trazas, oracle aislado, artefactos fuera de Git y claims PASS.
- `git diff --check`: PASS.

## Qué se puede afirmar

En este experimento acotado, PREMiSE mostró una política capaz de:

- evitar las escrituras stale en los escenarios mutables evaluados;
- detectar un conflicto CAS antes de producir efectos;
- completar cambios compatibles tras una mutación sin una lectura redundante cuando el current es completo;
- rechazar cambios incompatibles, revocaciones, leases inválidos y snapshots parciales;
- conservar la separación entre evidencia, frontera, dependencia e idempotencia.

## Qué no se puede afirmar

Esta campaña no demuestra:

- una reducción universal de coste, tokens o requests frente a toda memoria convencional;
- ejecución real contra repositorios GitHub, PostgreSQL, calendarios o proveedores cloud;
- precios, latencia o disponibilidad de un proveedor LLM;
- comportamiento de GPT, Claude, Gemini u otro proveedor externo;
- seguridad, atomicidad o rendimiento de producción en millones de registros;
- una mejora comercial del 70–90% ni una clasificación GA.

El siguiente paso válido es un holdout de al menos 200 tareas con un adaptador real, telemetría real de tokens/coste, tareas selladas, examinador externo y mutaciones reproducibles. Hasta entonces PREMiSE debe seguir descrito como candidate/RC, no como solución universal.
