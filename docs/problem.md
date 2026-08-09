# PREMiSE: problema, tesis y límites

> Documento W1-H para PREMiSE v0.1. Describe el contrato y la arquitectura objetivo; no presenta como implementadas las piezas que pertenecen a otras olas.

## Tesis protocol-first

PREMiSE es un protocolo de validez para memorias de agentes. Su tesis es:

> MCP estandarizó cómo los agentes acceden al mundo. PREMiSE aspira a estandarizar cómo sus memorias permanecen sincronizadas con ese mundo.

El límite entre las piezas es deliberado:

```text
LLM / Agent
     ↓
Memory
     ↓
PREMiSE
     ↓
Validators / Tools / MCP / World
```

Un enfoque protocol-first fija primero los nombres, los schemas, los estados, los eventos y las reglas de propagación. Después permite que distintas memorias, adapters y lenguajes demuestren la misma semántica. PREMiSE no es una memoria concreta ni un framework de agentes.

## El problema

Una memoria de agente puede seguir conteniendo un recuerdo después de que cambie la fuente que lo justificaba. El recuerdo también puede ser una conclusión derivada de otros recuerdos, por lo que un cambio en una sola fuente puede afectar a una parte del grafo y no al resto.

Sin un contrato común, cada sistema tiene que decidir por su cuenta:

- cómo conservar la procedencia y el momento de observación;
- cómo identificar la versión del mundo de la que depende un recuerdo;
- cómo distinguir evidencia fresca, evidencia que debe comprobarse, evidencia invalidada y vigencia desconocida;
- cómo propagar un cambio a recuerdos derivados;
- cómo pedir una revalidación y cómo conservar la historia sin presentar un recuerdo invalidado como vigente.

Las soluciones locales —por ejemplo, releer siempre, usar un TTL genérico o pedir una comprobación en el prompt— no expresan necesariamente la relación entre una fuente y sus derivados. Tampoco proporcionan una semántica común que pueda comprobarse con los mismos test vectors en varios adapters.

El problema que PREMiSE acota es, por tanto:

> Dado un recuerdo que pertenece a una memoria existente, sus referencias de procedencia, su política de validez y sus dependencias, ¿cómo puede un sistema declarar de forma portable si ese recuerdo sigue siendo utilizable y qué debe revalidarse cuando cambia el mundo?

PREMiSE responde con metadata y comportamiento explícitos. No intenta decidir por sí mismo si el contenido es verdadero: registra qué evidencia lo soporta, qué versión observó un validator y qué estado normativo se deriva de esa evidencia.

Los términos y reglas detallados están en [Conceptos](./concepts.md); la separación de componentes está en [Arquitectura](./architecture.md).

## Qué estandariza v0.1

La release v0.1 separa tres productos:

1. La especificación PREMiSE: schemas, estados, eventos y reglas normativas.
2. Una implementación TypeScript de referencia: estado, grafo, eventos y revalidación, no un sistema de memoria.
3. Conformance y adapters: herramientas para demostrar que una memoria existente conserva la semántica del protocolo.

El contrato permite que una memoria guarde los envelopes dentro de su propio almacenamiento o use un sidecar. En ambos casos, el contenido del recuerdo, su persistencia principal y su forma de recuperarlo siguen perteneciendo a la memoria.

## Límites de responsabilidad

| Sistema | Responsabilidad | No delega en PREMiSE |
| --- | --- | --- |
| Memoria | Conserva el contenido, su almacenamiento principal y su retrieval. | No entrega a PREMiSE la propiedad del contenido ni de los embeddings. |
| Adapter | Asocia un `memoryId` con un envelope, consulta `check()` y aplica el resultado a su flujo de uso. | No redefine estados ni reglas de propagación. |
| PREMiSE | Conserva metadata de validez, referencias de procedencia, grafo de dependencias, eventos y resultados de revalidación. | No almacena el recuerdo completo ni hace retrieval semántico. |
| Validator | Interpreta una referencia y su version token frente a una fuente externa. | No modifica el contenido de la memoria. |
| Fuente, tool o MCP | Expone el estado observable del mundo. | No recibe de PREMiSE una garantía de que su contenido sea inmutable. |

`contentDigest` puede asociarse al envelope, pero es una referencia opcional al contenido; no convierte a PREMiSE en su almacén. La invalidación cambia el estado metadata y la historia de validez, no borra el contenido original.

## No-objetivos de v0.1

PREMiSE no construye ni promete construir:

- una Vector DB, embeddings, ranking o retrieval propio;
- consolidación, resumen o inferencia de dependencias mediante un LLM;
- una memoria principal, un framework de agentes o un servicio cloud;
- un dashboard o una interfaz de administración;
- una autoridad global sobre la verdad del mundo o sobre la semántica interna de cada version token;
- un transporte RPC obligatorio: el protocolo define comportamiento, no una API de red concreta;
- un adapter real de GitHub en v0.1;
- una migración de contenido desde una memoria existente hacia PREMiSE.

Las dependencias se declaran por la memoria o por su adapter; PREMiSE no las infiere automáticamente. Los validators interpretan tokens opacos como `git.commit`; el protocolo solo compara el resultado que el validator declara.

## Claims y evidencia

Los estados, eventos y reglas descritos aquí son objetivos normativos de v0.1, no resultados experimentales. En particular, los objetivos del benchmark del plan —reducción de stale recalls, reparación dinámica, tasa de supresión falsa y ahorro de relecturas— solo podrán afirmarse después de ejecutar los escenarios y guardar sus resultados.

La base de bootstrap contiene scaffolds vacíos para los paquetes del workspace. Este documento no afirma que el motor, los validators, la persistencia, la conformance o el benchmark ya estén implementados. El gate de Ola 1 seguirá requiriendo que la especificación, los schemas y los test vectors sean entregados y ejecutables por sus owners.
