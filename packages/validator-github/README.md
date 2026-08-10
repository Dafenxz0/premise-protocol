# `@premise/validator-github`

Adapter real de GitHub para PREMiSE. Usa únicamente `fetch` estándar y consulta GitHub REST sin persistir contenido ni credenciales.

## Fuentes soportadas

`versionFor()` acepta estas URI, además de sus equivalentes `https://github.com/...`:

```text
github://owner/repo/commit/<sha-o-ref>
github://owner/repo/issues/<number>
github://owner/repo/pulls/<number>
github://owner/repo/pulls/<number>/head
github://owner/repo/pulls/<number>/checks
github://owner/repo/pulls/<number>/reviews
```

Los commits usan su SHA. Issues y pull requests incluyen los campos de actualización relevantes; `head`, checks y reviews tienen tokens independientes. Un `validate()` con un `404` devuelve `MISSING`; timeouts, errores de red, respuestas inválidas y límites agotados devuelven `UNKNOWN` sin propagar el cuerpo de GitHub.

## Configuración

La configuración se inyecta en el constructor. No hay tokens ni secretos en el paquete:

```ts
import { GitHubValidator } from "@premise/validator-github";

const github = new GitHubValidator({
  tokenProvider: () => process.env.GITHUB_TOKEN,
  baseUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
  timeoutMs: 10_000,
  maxRetries: 2,
  cache: new Map()
});

const version = await github.versionFor("github://acme/widget/pulls/42/head");
```

Las respuestas con `ETag` se guardan en la caché inyectada y las siguientes peticiones envían `If-None-Match`. Los reintentos están limitados a cinco como máximo, solo se aplican a fallos transitorios y respetan `Retry-After` con un tope configurable. `lastRateLimit` expone los headers de cuota observados; `getRateLimit()` consulta `/rate_limit`.

## Webhooks

La firma se verifica sobre el cuerpo original, antes de parsear JSON, usando `X-Hub-Signature-256` y comparación resistente a timing:

```ts
const webhook = github.parseWebhook(rawRequestBody, requestHeaders);
// webhook.event, webhook.deliveryId y webhook.payload
```

Pasa `webhookSecret` por inyección. También están disponibles `signWebhookPayload`, `verifyWebhookSignature` y `parseWebhook` para integrar cualquier servidor HTTP.

## Live opt-in

Las pruebas normales nunca salen a Internet: usan un servidor HTTP local y fixtures bajo `test/fixtures`. Para hacer una comprobación real de forma explícita:

```powershell
$env:GITHUB_LIVE = "1"
$env:GITHUB_TOKEN = "<token-inyectado>"
$env:GITHUB_SOURCE_URI = "github://owner/repo/commit/main"
pnpm --filter @premise/validator-github test:live
```

`test:live` no se ejecuta desde `test` y se salta si `GITHUB_LIVE` no es exactamente `1`. Nunca escribas el token en el código, fixtures o logs.
