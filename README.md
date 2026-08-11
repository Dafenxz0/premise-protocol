# PREMiSE Protocol

<p align="center">
  <img src="assets/premise-logo.jpg" alt="Logo de PREMiSE Memory Validity Protocol" width="760">
</p>

<p align="center">
  <strong>La memoria de un agente no debería quedarse congelada en el pasado.</strong><br>
  PREMiSE comprueba si un recuerdo sigue siendo seguro antes de que el agente lo use.
</p>

<p align="center">
  <a href="https://github.com/Dafenxz0/premise-protocol/actions/workflows/ci.yml"><img src="https://github.com/Dafenxz0/premise-protocol/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI verde"></a>
  <img src="https://img.shields.io/badge/Node.js-24-14B8A6?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 24">
  <img src="https://img.shields.io/badge/pnpm-10-F59E0B?style=flat-square&logo=pnpm&logoColor=white" alt="pnpm 10">
  <img src="https://img.shields.io/badge/estado-candidate-2563EB?style=flat-square" alt="Estado candidate">
</p>

## Estado actual

PREMiSE ya es un protocolo implementado, portable y probado para trabajar con
recuerdos cuya fuente puede cambiar. El núcleo incluye:

- contrato portable `premise/1` con vectores de conformidad en TypeScript y Python;
- runtime con evidencias, versiones, dependencias, invalidación y revalidación;
- protección compare-and-set (CAS) antes de aplicar una acción;
- adapters y ejemplos para filesystem, Git, GitHub, PostgreSQL y MCP;
- campañas mutables ciegas de 100 y 200 tareas, con tablas de seguridad y coste proxy;
- Node.js 24, tests, CI, documentación y assets visuales.

La etiqueta actual es **candidate**: la evidencia de tokens de proveedor, coste
facturado y generalización todavía está pendiente de una campaña conectada a un
runtime de modelo real. Los resultados de abajo son reproducibles y útiles para
comparar estrategias, pero no son una promesa universal.

## PREMiSE en una frase

PREMiSE añade una comprobación de vigencia entre la memoria de un agente y la
acción que quiere ejecutar: si la evidencia sigue igual, continúa; si cambió,
revalida; si el write llega tarde, el CAS lo bloquea.

No sustituye el contenido de tu memoria ni pretende ser una base de datos. Cambia
algo más importante: evita que el agente trate un recuerdo antiguo como un hecho
actual.

## Cómo funciona

```text
recuerdo + versión de su fuente
              ↓
       check local de vigencia
        ↓                 ↓
     FRESH             STALE / UNKNOWN
        ↓                 ↓
   preparar acción     revalidar fuente
        ↓                 ↓
       write protegido por versión (CAS)
              ↓
       aplicar o rechazar con seguridad
```

![Flujo de PREMiSE](assets/premise-overview.jpg)

Los estados que entiende una aplicación son sencillos:

| Estado | Qué significa |
| --- | --- |
| `FRESH` | La evidencia coincide con la versión observada; se puede usar. |
| `STALE` | Algo cambió o puede haber cambiado; hay que comprobarlo. |
| `INVALID` | La evidencia ya no respalda el recuerdo. |
| `UNKNOWN` | No hay información suficiente para actuar con seguridad. |

## Resultados fáciles de leer

Campaña ciega de **200 tareas** con **100 mutaciones**: 100 estables, 40
reparables, 40 incompatibles y 20 cambios durante el write (TOCTOU). Las
estrategias recibieron el mismo conjunto de tareas; la identidad de cada brazo
se reveló después del examen.

| Estrategia | Correctas | Inseguras / 100 | Peticiones / 100 | Lecturas / 100 | Tokens proxy visibles / tarea | Coste proxy / 100 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Memoria básica | 50/100 | 50 | 100 | 0 | 118,0 | 0,001995 USD |
| Memoria mejorada convencional | 90/100 | 10 | 200 | 100 | 169,8 | 0,004581 USD |
| **PREMiSE** | **100/100** | **0** | **140** | **50** | **146,4** | **0,0034425 USD** |

Lectura rápida frente a la memoria convencional: PREMiSE usa **30% menos
peticiones**, **50% menos lecturas**, **13,8% menos tokens proxy visibles** y
**24,9% menos coste proxy**, sin acciones inseguras en esta campaña.

La memoria básica parece barata porque no comprueba cambios: por eso falla en la
mitad de las tareas. Un sistema no gana por llamar menos si actúa con datos
obsoletos. Los tokens y costes de la tabla son proxies deterministas de payloads;
los tokens reales del proveedor y el coste facturado están en
`UNKNOWN/NOT_MEASURED`.

La serie completa —100-A, 100-B, 200-A, 200-B y 200-C— está descrita en la
[campaña mutable](./benchmarks/premisebench-agent/MUTATION_CAMPAIGN.md) y sus
artefactos generados se mantienen fuera de Git para no mezclar resultados con
código fuente.

## Scientific MVP y LLM reales

El siguiente gate está definido en [Scientific MVP](./docs/scientific-mvp.md) y
en el [preregistro](./benchmarks/premisebench-agent/PREREGISTRATION.md). Añade
`Safe Completion`, `Cost per Safe Attempt`, `CSFA`, trabajo desperdiciado,
MDE/power analysis, `Smart Revalidate`, `Always Revalidate`, un agente
determinista perfecto y un `Ideal Oracle` que solo puede usar el examinador.

El harness de [LLM reales](./benchmarks/premisebench-agent/llm/README.md)
soporta Gemini, Anthropic y endpoints OpenAI-compatible mediante HTTP nativo.
Registra tokens, reintentos y latencia; si no hay billing verificable devuelve
`UNKNOWN`, y si no hay credencial devuelve `NOT_RUN`. El piloto no es todavía
un holdout ni una promesa de ahorro para proveedores. Las respuestas `429`, los
errores del proveedor y los fallos del contrato se conservan como `ERROR`, nunca
como ceros.

## Qué aporta el protocolo

| Problema | Qué hace PREMiSE |
| --- | --- |
| Una memoria se queda vieja | Conserva la versión y la procedencia de la evidencia. |
| Una fuente cambia mientras trabajas | Propaga la invalidación y revalida solo lo necesario. |
| Dos agentes actúan sobre versiones distintas | Usa dependencias y tokens de versión para detectar conflictos. |
| La fuente cambia durante el write | CAS rechaza la acción basada en una versión antigua. |
| El contexto se hace grande | Agrupa, deduplica y evita revalidaciones repetidas. |

![Arquitectura visual de PREMiSE](assets/premise-validity-architecture.png)

## Lo que PREMiSE no es

PREMiSE no es una base de datos vectorial, un sistema de embeddings, un motor de
retrieval, una memoria principal, un dashboard, un servicio cloud ni una
autoridad universal sobre la verdad. La aplicación que lo integra sigue siendo
responsable de guardar el contenido, consultar sus fuentes y decidir qué hacer
cuando PREMiSE devuelve `REJECT`.

El adapter GitHub real está disponible para observación controlada en modo
lectura. Las mutaciones de benchmarks se ejecutan en mundos desechables; no se
modifican repositorios personales sin un destino temporal autorizado.

## Empezar

Necesitas Node.js 24 y pnpm 10:

```bash
git clone https://github.com/Dafenxz0/premise-protocol.git
cd premise-protocol
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Conformance y benchmark mutable:

```bash
pnpm conformance:premise1
node benchmarks/premisebench-agent/mutation-campaign.mjs --tasks=200 --seed=20260812 --round=local
node scripts/premisebench-agent/mutation-campaign-self-check.mjs --tasks=200 --round=local
```

El runner publica por brazo seguridad, completitud, peticiones, lecturas,
writes, tokens proxy visibles, payload interno no facturable y coste proxy. Si
se conecta un proveedor que no expone tokens o billing, el resultado seguirá
siendo `UNKNOWN`, nunca cero.

## Dónde está cada cosa

| Ruta | Para qué sirve |
| --- | --- |
| [`spec/premise-1/`](./spec/premise-1/) | Contrato pequeño, decisiones y reglas de eficiencia. |
| [`packages/runtime-core/`](./packages/runtime-core/) | Evidencias, dependencias, invalidación y revalidación. |
| [`packages/protocol-types/`](./packages/protocol-types/) | Tipos y validación del protocolo. |
| [`packages/validator-github/`](./packages/validator-github/) | Lecturas GitHub, ETags, checks, reviews y webhooks. |
| [`packages/store-postgres/`](./packages/store-postgres/) | Adapter PostgreSQL y persistencia durable. |
| [`packages/context-engine/`](./packages/context-engine/) | Selección de contexto con presupuesto y trazabilidad. |
| [`benchmarks/premisebench-agent/`](./benchmarks/premisebench-agent/) | Baselines, mutaciones, examinador ciego y tablas. |
| [`docs/`](./docs/) | Integración, operación, límites y metodología. |
| [`assets/`](./assets/) | Logo, overview y arquitectura visual. |

## Evidencia y límites

La [especificación de eficiencia](./spec/premise-1/efficiency.md) define cómo
separar peticiones externas, checks locales, payload interno, tokens visibles y
billing real. La [documentación del benchmark](./docs/benchmarks/premisebench-agent.md)
explica el diseño, los controles y la lectura de los resultados.

Lo que sí demuestra la campaña actual: en este mundo mutable y con estas tareas,
PREMiSE mantiene la seguridad completa y reduce operaciones frente a la memoria
convencional. Lo que todavía no demuestra: coste de un proveedor concreto,
calidad universal de agentes, disponibilidad en producción o comportamiento en
cualquier conector. Esas afirmaciones requieren campañas live con telemetría y
holdout independiente.

## Sensitivity matrix

Run the deterministic development matrix across volatility and risk tiers:

```text
pnpm benchmark:scientific:matrix
```

It produces anonymous candidate tables and a separate blind examiner under
`.tmp/scientific-mvp/matrix/`. This is reproducible local evidence, not an
external holdout, provider billing audit, or universal product claim.

## Licencia

Este repositorio no incluye una licencia pública por diseño.
