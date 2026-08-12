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

`provider` accepts `openai-compatible`, `openrouter`, `zai`, `anthropic`, or `gemini`. Credentials are names of environment variables, never inline values. `prompt` may be supplied in the config as a default user prompt; a call can instead provide `prompt` or provider-neutral `messages`.

The campaign compares five deliberately different policies: `basic` uses the
initial snapshot, `conventional` reads before an unguarded write, `always`
revalidates and uses CAS every time, `premise` uses local freshness plus CAS,
and `smart` uses an invalidation signal plus CAS without PREMiSE semantics.
The first two are intentionally unsafe controls under TOCTOU; `always` is the
safe high-work reference point.

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
    "totalTokens": 0,
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
provider response supplies it. A separate `listedCost` estimate may be
calculated from a frozen published price sheet; it is never a billing receipt.

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
latency, model turns, provider attempts, source requests, external reads/writes,
CAS conflicts, conflict snapshots reused, protocol errors and request-budget
usage are stored in `summary.json` and `manifest.json`.
When retries are enabled without a request cap, `retry-delay-ms` applies an
exponential bounded backoff and respects numeric `Retry-After` responses.

The public trace also records why an arm ended (`ACTION_ACCEPTED`, `REJECTED`, `TURN_LIMIT`,
`MODEL_PROTOCOL_ERROR`, provider error, or budget stop). A successful guarded
action is never relabelled as safe when the model failed to complete the
bounded protocol; the evaluator remains fail-closed.

Nemotron’s bounded live command is available as:

```powershell
pnpm benchmark:llm:nemotron-lightning
```

Z.ai GLM-4.7-Flash uses the official OpenAI-compatible endpoint and the
published free-tier price snapshot. Keep `ZAI_API_KEY` in the process environment only;
the provider may return usage but does not provide a billing receipt through
this harness:

```powershell
$env:ZAI_API_KEY = '<temporary-key>'
node benchmarks/premisebench-agent/llm/campaign.mjs `
  --provider=zai --model=glm-4.7-flash `
  --tasks=4 --scenario=standard --max-turns=4 `
  --max-tokens=128 --max-retries=0 `
  --max-provider-requests=80 --max-provider-tokens=30000 `
  --min-request-interval-ms=5000 --response-format=none `
  --round=zai-glm47flash-small-complete
```
