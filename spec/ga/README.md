# PREMiSE v2.0 GA evidence contract

La carpeta `spec/ga` define qué debe demostrar una release antes de llamarse `v2.0.0 GA`.

- [`acceptance.json`](./acceptance.json) es la fuente machine-readable de los gates y umbrales.
- `candidate` significa que hay implementación en progreso o evidencia incompleta.
- `evidence-checked` significa que el gate encontró todos los artefactos declarados; no sustituye la revisión humana.
- La etiqueta `GA` exige además reproducción independiente, revisión de seguridad y rollback verificado.

Los archivos de evidencia deben incluir el commit, dataset, configuración, hardware, trazas y errores. Los fixtures locales sirven para CI y regresión, pero no cuentan como benchmarks externos.
