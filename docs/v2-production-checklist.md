# Checklist de salida PREMiSE v2

Este documento separa lo que ya está implementado de lo que todavía requiere infraestructura o evidencia externa. Un release no debe convertir un “adapter” en una promesa de disponibilidad.

## Listo en el repositorio

- [x] Contrato v2 aditivo y migración v1 explícita.
- [x] Evidencias múltiples, conflictos, confianza declarada y temporalidad.
- [x] Eventos con tenant, digest e idempotency key.
- [x] Runtime con dependencias, propagación, validación, snapshots y replay.
- [x] SQLite durable y contrato PostgreSQL inyectable.
- [x] GitHub REST real opt-in con retries, ETag, rate limits y webhook HMAC.
- [x] Context engine con presupuesto, gates de frescura, jerarquía y deduplicación.
- [x] Benchmarks offline reproducibles y live opt-in con trazas.
- [x] Compatibilidad v0.1 preservada en sus entrypoints existentes.

## Requiere una campaña de despliegue antes de GA

- [ ] Ejecutar GitHub App/OAuth en un tenant de prueba con permisos mínimos.
- [ ] Validar PostgreSQL contra una versión soportada y una política de migraciones operativa.
- [ ] Probar carga de 1M de memorias y contextos 128k/1M con hardware documentado.
- [ ] Ejecutar chaos, reinicios, concurrencia y soak en dos infraestructuras.
- [ ] Realizar revisión de seguridad independiente y escaneo sin vulnerabilidades altas/críticas.
- [ ] Generar intervalos de confianza y holdout ciego para cualquier cifra pública.
- [ ] Publicar imagen/runner reproducible y documentación de secretos, RBAC, backup y retención.

Hasta cerrar esas casillas, PREMiSE v2 debe etiquetarse como release candidate técnico, no como servicio cloud listo para producción.
