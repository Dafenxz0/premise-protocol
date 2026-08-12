# Minimal real-LLM candidate layer

This directory is provider-neutral and uses only the platform `fetch` plus Node standard-library modules. Importing it never performs network I/O.

Declarative configuration can be JSON text or a JSON file:

```json
{
  "provider": "openai-compatible",
  "model": "model-id",
  "credentialEnv": "OPENAI_API_KEY",
  "systemPrompt": "Follow the candidate contract.",
  "temperature": 0,
  "maxTokens": 256,
  "timeoutMs": 30000,
  "maxRetries": 2
}
```

`provider` accepts `openai-compatible`, `anthropic`, or `gemini`. Credentials are names of environment variables, never inline values. `prompt` may be supplied in the config as a default user prompt; a call can instead provide `prompt` or provider-neutral `messages`.

Set `responseFormat` to `"json-object"` when the provider supports structured
JSON. The campaign uses this mode to reduce protocol-parser noise while still
recording invalid responses as failures.

```js
import { createLlmCandidate, loadConfig } from "./index.mjs";

const candidate = createLlmCandidate(await loadConfig("candidate.json"));
const result = await candidate.complete({ taskId: "task-1", prompt: "Read the source and act safely." });
```

The returned JSON-safe envelope is `premisebench-llm/1`:

```json
{
  "protocol": "premisebench-llm/1",
  "type": "result",
  "status": "OK | NOT_RUN | ERROR",
  "provider": "...",
  "model": "...",
  "promptHash": "sha256:...",
  "temperature": 0,
  "maxTokens": 256,
  "output": "...",
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "cachedTokens": 0,
    "toolCalls": 0,
    "retries": 0,
    "latencyMs": 0,
    "providerCost": null
  }
}
```

`NOT_RUN` is returned before `fetch` when the configured credential is absent. It carries no prompt, response, credential, or environment value. The existing JSONL harness can serialize one result per line and map `output`/tool calls to its own candidate messages later; this layer does not modify that harness.

The campaign runner writes `blind-report.json`, `examined-report.json` and a
separate `mapping.private.json`. If any arm is `ERROR` or `NOT_RUN`, the blind
examiner emits no partial ranking. Provider cost remains `UNKNOWN` unless the
provider response supplies it or a frozen price sheet is explicitly added.

Example real-provider pilot (requires `GEMINI_API_KEY`):

```powershell
node benchmarks/premisebench-agent/llm/campaign.mjs --provider=gemini --model=gemini-3.5-flash-lite --tasks=5 --seed=20260811 --round=gemini-pilot --max-retries=0 --delay-ms=3000
```

For a free OpenRouter model, use a conservative request budget and serial
spacing. The Ling Tiny run below is intentionally a small live integration
pilot: it is useful for wiring and telemetry, not for a statistically strong
model claim. `OPENROUTER_API_KEY` must exist in the process environment; the
key is never accepted inline or written to artifacts.

```powershell
node benchmarks/premisebench-agent/llm/campaign.mjs `
  --provider=openrouter `
  --model=inclusionai/ling-3.0-tiny:free `
  --tasks=2 --scenario=hard --volatility=50 --max-turns=4 `
  --max-tokens=128 --max-retries=0 `
  --max-provider-requests=36 --max-provider-tokens=24000 `
  --min-request-interval-ms=4000 `
  --response-format=none --round=ling-tiny-live
```

`max-provider-requests` is a hard completion-request cap and
`max-provider-tokens` is a hard observed provider-token cap, and
`min-request-interval-ms` serializes calls. If either cap is reached, or
OpenRouter returns `429`/`402`, the campaign stops and the blind examiner does
not rank partial arms. For OpenRouter runs the harness also snapshots the
public model pricing endpoint. `providerCost` is a provider-reported value;
`listedCost` is a separately labelled estimate from that frozen price
snapshot, and is never presented as a billing receipt. Token counts, retries,
latency, completion requests, external reads/writes, protocol errors and
request-budget usage are stored in `summary.json` and `manifest.json`.
