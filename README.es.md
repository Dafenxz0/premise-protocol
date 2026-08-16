# PREMiSE

![PREMiSE](assets/premise-logo.jpg)

## Decisiones de agentes coherentes con un mundo que cambia

PREMiSE es un protocolo abierto y un runtime para agentes que leen información externa, razonan sobre ella y después actúan. Registra de qué evidencias depende una decisión, detecta cuándo esas evidencias cambian y evita que una decisión obsoleta se use en silencio.

PREMiSE no es una base de datos vectorial, un sistema de embeddings, un motor de retrieval, una memoria principal, un dashboard, un servicio cloud ni una autoridad sobre la verdad. Es la capa de coherencia entre un agente y los sistemas cuyo estado puede cambiar mientras el agente trabaja.

## Instalar en dos minutos

PREMiSE no depende de un proveedor de agentes. No necesitas instalar este
monorepo, una base de datos ni un servicio cloud para añadir el protocolo y su
servidor MCP portable a un proyecto.

```bash
git clone --depth 1 https://github.com/Dafenxz0/premise-protocol.git .premise-source
node .premise-source/plugins/premise-codex/install.mjs --agent all --project .
node .premise-source/plugins/premise-codex/install.mjs --check --agent all --project .
```

| Host | Comando | Qué instala |
| --- | --- | --- |
| Codex | `--agent codex` | `.agents/skills/premise` y la entrada MCP portable |
| Claude Code | `--agent claude-code` | import gestionado en `CLAUDE.md` y `.mcp.json` |
| Otros agentes compatibles con MCP | `--agent generic` | guía en `AGENTS.md` y `.premise/premise.mcp.json` |
| Todos | `--agent all` | el kit portable completo |

El modo inicial es `SELFTEST`: comprueba que el servidor copiado arranca y
responde, pero no es una memoria local ni una autoridad sobre la verdad. Para
un despliegue remoto define `PREMISE_MODE`, `PREMISE_BASE_URL`,
`PREMISE_TENANT` y `PREMISE_TOKEN` solo en el entorno del proceso. Nunca
guardes credenciales en `.mcp.json`. Consulta la [guía de instalación de
agentes](docs/agent-installation.md) para PowerShell, modo remoto y retirada.

![Flujo de PREMiSE](assets/premise-overview.jpg)

## PREMiSE en una frase

> PREMiSE permite saber si los hechos detrás de la siguiente acción de un agente siguen vigentes y obliga a comprobarlos de nuevo cuando dejan de estarlo.

## Cómo funciona

```text
observar → registrar evidencia y versión → derivar una decisión → comprobar antes de actuar
                                                        ↓
                                  vigente: usar · obsoleta: revalidar · inválida: rechazar
```

El protocolo está separado del sistema fuente. GitHub, un archivo, una fila de base de datos o una API siguen siendo dueños de sus datos. PREMiSE registra evidencias, versiones, dependencias y recibos para que el agente pueda tomar una decisión segura justo antes de actuar.

### Ejemplo sencillo

1. El agente lee `config@v41` y prepara un cambio.
2. Otro proceso publica `config@v42`.
3. PREMiSE marca como obsoleta la decisión dependiente.
4. El agente revalida antes de escribir o la acción protegida se rechaza.

PREMiSE no intenta recordar más cosas; evita que el agente confunda una observación antigua con el estado actual.

## Qué contiene hoy este repositorio

Incluye los contratos del protocolo, un runtime TypeScript, implementaciones de referencia, stores y adapters, vectores de conformidad y un laboratorio de benchmarks con evidencia y límites explícitos.

| Área | Estado actual |
| --- | --- |
| Contratos | Especificaciones `premise/1` y `premise/1.1` con vectores |
| Runtime | Propagación de dependencias, revalidación, recibos, idempotencia y acciones protegidas |
| Stores | Paquetes en memoria, SQLite y compatibles con PostgreSQL |
| Adapters | Filesystem, Git/GitHub-like, HTTP, webhook y ejemplos del protocolo |
| Conformidad | TypeScript y Python se comprueban contra vectores compartidos |
| Evidencia | Experimentos deterministas indexados en [`docs/evidence`](docs/evidence/README.md) |
| Estado | Candidato de ingeniería/investigación; no es una promesa de GA universal |

## Desarrollar el repositorio

Requisitos: Node.js 24 y pnpm 10.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

La integración mínima es observar una fuente, asociar su revisión a una premisa, derivar la acción, ejecutar `check` justo antes del efecto lateral y hacer la escritura condicional del conector. Empieza por [`@premise/runtime-core`](packages/runtime-core/README.md) y continúa con la [guía de integración](docs/api-v2.md).

## Evidencia, no promesas

El laboratorio evalúa PREMiSE con fuentes que cambian y mide seguridad, vigencia, peticiones, lecturas, latencia y coste por acción fresca completada. También conserva resultados negativos e inconclusos.

Consulta el índice de evidencia en [`docs/evidence/README.md`](docs/evidence/README.md). La documentación separa lo medido de lo planificado y evita convertir campañas exploratorias en claims de producto.

Los resultados actuales no justifican afirmar que PREMiSE sea universalmente más seguro, barato o listo para producción en cualquier conector. El experimento de compactación, en particular, sigue en estado no-go hasta demostrar sus invariantes.

## Documentación

- [Conceptos](docs/concepts.md)
- [Protocolo y versionado](docs/versioning.md)
- [Arquitectura](docs/architecture.md)
- [API e integración](docs/api-v2.md)
- [Evidencia de benchmarks](docs/evidence/README.md)
- [Operaciones y despliegue](docs/deployment-v2.md)
- [Límites de seguridad](docs/security-v2.md)

## Alcance y límites

PREMiSE no decide si una fuente es verdadera en sentido moral, legal o semántico. No sustituye el sistema de origen, no resuelve retrieval y no garantiza que el plan del agente sea correcto. Aporta una frontera determinista de coherencia: una decisión solo puede continuar si sus premisas cumplen la política requerida por la acción.

La siguiente meta de ingeniería es una infraestructura de coherencia acotada y recuperable tras reinicios: journal durable separado, checkpoints, continuidad de eventos, una API de adapters más sencilla, single-flight distribuido y semántica de premisas más completa.

## Contribuir

Ejecuta las pruebas del paquete afectado y la validación completa antes de abrir una PR. Toda afirmación de benchmark debe incluir manifiesto, reglas del evaluador, digest de trazas y resultados negativos. Los artefactos generados no deben entrar en Git salvo que sean fixtures documentados.

```bash
pnpm build
pnpm test
pnpm lint
```
