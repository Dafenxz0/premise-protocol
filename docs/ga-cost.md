# Medición de coste para PREMiSE v2.0 GA

Este medidor calcula el coste atribuible a un workload de PREMiSE por cada
1.000 operaciones. Es un instrumento de transparencia y de preparación de
evidencia: no consulta al proveedor, no inventa una factura y no convierte una
estimación local en una medición de producción.

El umbral público actual es **0,05 USD por 1.000 operaciones**. El runner lo
mantiene fijo y lo identifica como
`spec/ga/acceptance.json#thresholds.costPerThousandOperationsUsdMax`; el input
no puede cambiarlo.

## Tres modos, tres significados

| Modo | Cómo calcula | ¿Puede ser evidencia del gate de coste? |
| --- | --- | --- |
| `modeled` | CPU, memoria y egress declarados multiplicados por tarifas unitarias. | No. Sirve para presupuestar o comparar hipótesis y siempre devuelve `eligibleForGa: false`. |
| `metered-infrastructure` | Consumo observado por un medidor de infraestructura multiplicado por una tarjeta de tarifas del proveedor. | Sí, si el export de medición, las tarifas y la traza están identificados por hashes y el resultado queda por debajo del umbral. |
| `provider-billing` | Total USD de una factura/export del proveedor, dividido por las operaciones cubiertas. | Sí, si la factura/export cubre exactamente esas operaciones, está identificado por hash y la traza permite reconciliar el workload. |

Los modos reales no prueban por sí solos disponibilidad, latencia, seguridad ni
los demás gates de GA. `eligibleForGa` significa únicamente que este resultado
puede satisfacer el gate de coste; el expediente completo todavía debe revisar
la evidencia y el resto de criterios.

## Entrada estricta

El runner solo acepta JSON con este contrato. Las unidades deben escribirse
exactamente como aparecen; `seconds`, `ms`, `GB/s`, `GiB-hour`, porcentajes,
monedas distintas de USD o valores como `1k` se rechazan para no esconder una
conversión ambigua.

```json
{
  "schemaVersion": "premise/ga-cost-input/1",
  "mode": "metered-infrastructure",
  "measurement": { "kind": "metered-infrastructure" },
  "source": {
    "kind": "meter-export",
    "reference": "billing://redacted/provider-export-2026-08",
    "sha256": "<64 hex characters>"
  },
  "trace": {
    "id": "trace-cost-2026-08-10-001",
    "sha256": "<64 hex characters>"
  },
  "usage": {
    "operations": 100000,
    "duration": { "value": 3600, "unit": "second" },
    "cpu": { "value": 100, "unit": "vCPU-hour" },
    "memory": { "value": 500, "unit": "GB-hour" },
    "egress": { "value": 10, "unit": "GB" }
  },
  "unitCosts": {
    "source": {
      "kind": "provider-rate-card",
      "reference": "rate-card://redacted/provider-2026-08",
      "sha256": "<64 hex characters>"
    },
    "cpu": { "usdPerUnit": 0.02, "unit": "vCPU-hour" },
    "memory": { "usdPerUnit": 0.001, "unit": "GB-hour" },
    "egress": { "usdPerUnit": 0.1, "unit": "GB" }
  }
}
```

Para `provider-billing`, sustituye `source.kind` por `provider-invoice` o
`provider-export` y `measurement.kind`/`mode` por `provider-billing`. En lugar
de `unitCosts`, usa:

```json
"invoice": {
  "totalUsd": 4.50,
  "currency": "USD",
  "operationsCovered": 100000
}
```

La factura debe estar previamente prorrateada al workload: el número de
`operationsCovered` tiene que coincidir exactamente con `usage.operations`.
Si un export cubre varios productos, tenants o workloads, no se debe atribuir
el total entero sin una regla de asignación documentada.

Para `modeled`, usa `mode: "modeled"`, `measurement.kind: "modeled"`,
`source.kind: "cost-model"` y `unitCosts`. Ese resultado es deliberadamente
no elegible para GA aunque el número parezca bueno.

## Ejecución

Desde la raíz del repositorio:

```powershell
node benchmarks/ga-cost/runner.mjs `
  --input .\billing\premise-cost-input.json `
  --output .\billing\premise-cost-report.json
```

También se puede pasar el JSON por stdin con `--input -`. No ejecutar el runner
sin input: termina con error y no crea una factura, una tasa ni un resultado
por defecto. Si el JSON está ausente, es inválido, contiene secretos, hashes
que no son SHA-256, unidades ambiguas, números negativos o cobertura de factura
inconsistente, falla cerrado y no emite un reporte.

La salida incluye `totalUsd`, `perThousandOperationsUsd`, el desglose por
recurso cuando se usan tarifas unitarias, `thresholdPassed`, el modo, la fuente,
los hashes de la fuente y de la traza y `eligibleForGa`.

El self-check de regresión se ejecuta así:

```powershell
node benchmarks/ga-cost/self-check.mjs
```

Sus datos son sintéticos y sus checks **no son evidencia GA**. Una ejecución
verde solo demuestra que el cálculo, el redondeo y los rechazos deterministas
siguen funcionando.

## Cómo adjuntar un export anonimizado de billing

1. Exporta desde el proveedor el periodo exacto que cubre el benchmark y
   conserva el fichero original en un almacén con acceso restringido. No lo
   pegues en un issue, en el repositorio ni en el prompt.
2. Crea una copia anonimizada. Elimina tokens, contraseñas, cookies, IDs de
   cuenta/proyecto si no son necesarios, nombres de personas, correos, URLs con
   credenciales y cualquier etiqueta que revele un secreto. Conserva proveedor,
   región, servicio, periodo, unidades, consumo, moneda, cargos y la regla de
   prorrateo. No redondees los importes sin documentarlo.
3. Calcula el SHA-256 de la copia exacta que se va a revisar. En PowerShell:

   ```powershell
   Get-FileHash .\billing\export-anon.json -Algorithm SHA256
   ```

4. Conserva una traza NDJSON o equivalente que permita reconciliar cada
   operación intentada y su tenant/workload sin incluir contenido privado.
   Calcula también el SHA-256 de esa traza. El `trace.id` del input debe ser
   estable y el `trace.sha256` debe corresponder al fichero adjunto.
5. Rellena `source.reference` y `unitCosts.source.reference` con referencias
   anonimizadas pero útiles, por ejemplo
   `billing://provider/2026-08/export-anon-01`. Adjunta los hashes, no las
   credenciales ni el export original.
6. Entrega juntos, mediante el canal seguro de revisión, el input JSON, el
   export anonimizado, la traza y el reporte generado. El revisor debe poder
   recalcular el digest y comprobar que `operationsCovered` coincide.

Un hash demuestra qué fichero se revisó; no demuestra que el fichero sea una
factura correcta. Para el claim de GA hay que conservar el origen, la ventana,
el proveedor/región, el método de asignación y una revisión independiente.
