# `@premise/connector-webhook`

Conector webhook genérico para PREMiSE v2. No crea conexiones ni lee credenciales: el secreto, `fetch` y el almacén de deduplicación se inyectan.

## Recepción segura

El formato por defecto firma los bytes UTF-8 como `${timestamp}.${body}` con HMAC-SHA256 y envía:

- `x-webhook-signature: sha256=<hex>`
- `x-webhook-timestamp: <Unix seconds>`
- `x-webhook-id: <delivery id>` (recomendado para deduplicación)

El parser limita el cuerpo a 1 MiB, exige JSON válido, compara la firma con `timingSafeEqual` y rechaza timestamps antiguos o futuros. Primero autentica la firma y después aplica la ventana temporal: si se altera el timestamp sin recalcular HMAC se obtiene `WebhookSignatureError`; solo un timestamp antiguo con una firma válida obtiene `WebhookReplayError`. El límite, ventana, nombres de cabecera y reloj son configurables.

```ts
import { WebhookConnector } from "@premise/connector-webhook";

const webhook = new WebhookConnector({
  secret: process.env.WEBHOOK_SECRET!,
  // En producción, sustituye el almacén en memoria por una tabla con UNIQUE(key).
});

const event = await webhook.receive(rawBody, request.headers);
if (!event.duplicate) await process(event.payload);
```

`handle()` libera la clave si el handler falla, de modo que el envío pueda reintentarse; un almacén externo debe implementar `claim` atómicamente y puede implementar `release`.

## Envío y retries

```ts
await webhook.deliver({
  url: "https://consumer.example/hooks/premise",
  deliveryId: "delivery-123",
  payload: { type: "MemoryRegistered", memoryId: "memory:1" }
});
```

Se reintentan errores de red y respuestas `408`, `425`, `429` y `5xx`, con backoff acotado y soporte para `Retry-After`. Inyecta `fetch` en CI para no usar red real.

```bash
pnpm --filter @premise/connector-webhook build
pnpm --filter @premise/connector-webhook test
```
