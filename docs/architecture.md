# PREMiSE v0.1: arquitectura de referencia

> Documento W1-H. Especifica límites y responsabilidades de la arquitectura objetivo. Los paquetes del workspace son scaffolds en la base de bootstrap y no se describen aquí como funcionalidad ya entregada.

## Principio de separación

PREMiSE se coloca entre una memoria existente y los mecanismos que pueden observar el mundo. La memoria conserva el contenido; PREMiSE conserva la información necesaria para decidir si ese contenido sigue siendo utilizable.

```text
┌──────────────────────┐
│ LLM / Agent          │
└──────────┬───────────┘
           │ reads / actions
┌──────────▼───────────┐
│ Memory system        │  content, primary storage, retrieval
└──────────┬───────────┘
           │ memoryId + envelope
┌──────────▼───────────┐
│ PREMiSE adapter      │  mapping, check(), application policy
└──────────┬───────────┘
           │ protocol operations
┌──────────▼───────────────────────────────────────────┐
│ PREMiSE core                                           │
│ envelopes · dependency DAG · states · events · replay │
│ validation coordination · usability checks             │
└──────────┬───────────────────────────────┬────────────┘
           │ metadata/events                │ source checks
┌──────────▼───────────┐          ┌─────────▼──────────────┐
│ Optional sidecar     │          │ Validators / tools /   │
│ envelopes + graph +  │          │ MCP / external world   │
│ event history        │          └────────────────────────┘
└──────────────────────┘
```

El protocolo no exige que el sidecar exista: un adapter puede guardar los envelopes en el almacenamiento de la memoria. La equivalencia depende de respetar la misma semántica, no de una topología concreta.

## Límites de datos

### Lo que entra en PREMiSE

- `memoryId` y, opcionalmente, `contentDigest`;
- referencias de procedencia: `sourceUri`, `observedAt`, versión y validator;
- política y estado de validez;
- relaciones `dependsOn` del grafo;
- eventos de registro, derivación, cambio, marcado, invalidación, revalidación y reemplazo;
- resultados de validators y la información necesaria para `check()` e `history()`.

### Lo que permanece fuera

- el texto, objeto o payload completo del recuerdo;
- la base de datos principal de la memoria y su historial de contenido;
- embeddings, índices vectoriales, ranking y retrieval semántico;
- inferencia de dependencias mediante un LLM;
- la autoridad para afirmar que una fuente externa es correcta.

Un sidecar SQLite puede persistir metadata, relaciones y eventos PREMiSE. No debe convertirse en un almacén del contenido ni en un buscador semántico. El paquete planificado para ese límite es [`@premise/index-sqlite`](../packages/index-sqlite/).

## Componentes del workspace

Las responsabilidades siguientes reflejan el plan v0.1 y distinguen el destino de cada paquete de su estado actual:

| Componente | Límite de responsabilidad | Entrega del plan |
| --- | --- | --- |
| [`@premise/protocol-types`](../packages/protocol-types/) | Tipos, parser y validación de envelopes y contratos. | W1-D |
| [`@premise/reference-ts`](../packages/reference-ts/) | Implementación de referencia del estado, DAG, eventos, replay y revalidación. | W1-E, W1-F y W2-A |
| [`@premise/index-sqlite`](../packages/index-sqlite/) | Sidecar persistente de envelopes, relaciones y eventos, sin contenido. | W2-B |
| [`@premise/conformance`](../packages/conformance/) | Runner y contrato para adapters compatibles. | W1-G |
| [`@premise/adapter-openai`](../packages/adapter-openai/) | Integración de una memoria o sesión OpenAI sin cambiar el protocolo. | W2-C |
| [`@premise/validator-filesystem`](../packages/validator-filesystem/) | Validator de recursos filesystem y SHA-256. | W2-D |
| [`@premise/validator-git`](../packages/validator-git/) | Validator de HEAD, blob y tree SHA. | W2-E |
| [`@premise/mcp-bridge`](../packages/mcp-bridge/) | Integración con lecturas y señales MCP; STALE y reread. | W2-F |
| [`@premise/testkit`](../packages/testkit/) | Clocks, generadores y soporte de property tests. | W3-D |
| [`@premise/benchmark`](../benchmarks/premise-memory-bench/) | Engine, escenarios, baselines, evaluadores y reportes del benchmark. | W2-G, W2-H y Ola 3 |

Los ejemplos [`generic-memory`](../examples/generic-memory/), [`openai-memory`](../examples/openai-memory/) y [`mcp-memory`](../examples/mcp-memory/) son consumidores demostrativos. No forman parte del núcleo del protocolo.

## Flujo de operaciones

1. La memoria crea o conserva el contenido de un recuerdo y asigna un `memoryId`.
2. El adapter registra un envelope con las referencias de procedencia, política y estado que correspondan.
3. Para una conclusión derivada, el adapter registra otro envelope con sus `dependsOn` explícitos. El núcleo rechaza los ciclos.
4. Una señal externa o un TTL puede marcar un recuerdo como `STALE`. La propagación solo recorre dependientes alcanzables.
5. `validate()` solicita a los validators una comprobación de la fuente. `UNCHANGED`, `CHANGED`, `MISSING` y `UNKNOWN` se traducen a las transiciones normativas de v0.1.
6. El núcleo recalcula los estados derivados y conserva los eventos.
7. Antes de usar un recuerdo, el adapter puede llamar a `check()`, que devuelve `USABLE`, `REVALIDATE` o `REJECT` según el estado y la política.
8. `history()` expone la historia metadata sin exigir que la memoria elimine su contenido histórico.

La secuencia no prescribe cómo una memoria hace retrieval ni cómo un agente decide una acción. `GATE` puede añadir una comprobación de seguridad antes de una acción, pero no cambia el protocolo central.

## Contratos entre componentes

### Memoria ↔ adapter

El adapter conoce cómo leer y escribir la memoria. Debe conservar el `memoryId` y aplicar las etiquetas de uso que devuelve PREMiSE. No puede convertir un estado `INVALID` en un recuerdo actual por conveniencia de presentación.

### Adapter ↔ núcleo PREMiSE

El núcleo recibe envelopes, dependencias y eventos; mantiene la semántica de estados y devuelve informes de propagación, validación o usabilidad. El adapter puede elegir transporte y almacenamiento, porque v0.1 no exige RPC.

### Núcleo ↔ validator

El núcleo entrega la referencia necesaria para comprobarla. El validator interpreta el esquema de versión y consulta la fuente que corresponda. Devuelve un resultado normativo; no edita el contenido de la memoria ni decide su retrieval.

### Núcleo ↔ sidecar

El sidecar guarda únicamente la representación persistente de metadata, grafo y eventos. La memoria puede usar otro almacenamiento siempre que preserve la misma semántica y la historia.

## Dependencias de implementación

La dependencia conceptual debe apuntar hacia los contratos:

```text
spec schemas / test vectors
          ↓
protocol-types
          ↓
reference-ts ───────→ validators
     ↓                    ↓
 index-sqlite        mcp-bridge
     ↓                    ↓
 adapters / examples / conformance / benchmark
```

El diagrama expresa responsabilidades, no un claim de imports ya implementados. Los schemas canónicos son los definidos por el plan:

```text
memory-envelope.schema.json
source-reference.schema.json
validation-result.schema.json
premise-event.schema.json
capabilities.schema.json
```

Sus archivos deben vivir bajo `spec/schemas/` cuando W1-B los entregue. La especificación normativa es `spec/premise-v0.1.md`; esta arquitectura no sustituye esos contratos ni puede reinterpretar sus estados.

## Restricciones y gate

- El protocolo define comportamiento y datos, no una implementación de memoria ni un transporte único.
- Los version tokens son opacos para el núcleo; solo el validator conoce su semántica.
- La invalidación afecta la metadata y los dependientes alcanzables, nunca borra automáticamente el contenido.
- No se añade retrieval, vector DB, embeddings, dashboard, servicio cloud ni inferencia automática de dependencias.
- No se afirma que un adapter o validator exista hasta que su ownership lo implemente y lo verifique.

El gate de Ola 1 exige que la especificación esté congelada, los schemas sean válidos y los test vectors sean ejecutables. Esta documentación fija la frontera de arquitectura; no declara que ese gate ya haya pasado en la base de bootstrap.
