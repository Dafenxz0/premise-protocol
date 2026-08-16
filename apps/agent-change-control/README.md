# Agent Change Control demo

This is a dependency-free visual demo of the PREMiSE product idea:

1. an agent observes source version `v1`;
2. a person or process changes the source to `v2`;
3. the old plan is blocked instead of being silently published;
4. the agent observes again and commits against `v2`.

Open `index.html` in a browser. The buttons run entirely in the page; they do
not call GitHub, PostgreSQL, a cloud service or an LLM.

Run the deterministic self-check with Node 24:

```bash
node apps/agent-change-control/self-check.mjs
```

This demo explains the boundary, not the full runtime or a production connector.
