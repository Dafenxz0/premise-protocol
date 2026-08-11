# External agent harness

The smoke runner uses deterministic in-process policies so that the causal
control can run without provider credentials. This directory defines the
external-candidate boundary for real campaigns.

The candidate is a separate process speaking one JSON object per line. It
receives the task id, the initial memory and a whitelist of tools. It never
receives `expected`, `oracle`, `groundTruth`, `mutation`, `outcome` or a final
label. The parent process owns the world and evaluates the result.

```text
node benchmarks/premisebench-agent/harness/runner.mjs \
  --candidate "node benchmarks/premisebench-agent/harness/candidate.mjs"
```

The default smoke does not invoke this process because it would introduce a
provider/agent implementation into a control result. A live campaign must
freeze the candidate command, prompt, model/provider, temperature, token
accounting and timeout in its manifest.
