function actionFor(snapshot) {
  if (snapshot.content.status === "blocked") return { kind: "reject", reason: "source-blocked", basedOnVersion: snapshot.version };
  return { kind: "apply", value: snapshot.content.value, basedOnVersion: snapshot.version };
}

async function execute(api, snapshot, guarded = false) {
  const action = actionFor(snapshot);
  return action.kind === "reject"
    ? api.reject(action)
    : guarded ? api.actIfVersion(snapshot.version, action) : api.act(action);
}

export const baselines = {
  A: { name: "No memory", async run(api) { return execute(api, await api.read()); } },
  B: { name: "Normal memory", async run(api) { return execute(api, api.memory); } },
  C: { name: "Prompted re-check", async run(api) { return execute(api, await api.read()); } },
  D: { name: "TTL cache", async run(api) { return execute(api, api.task.cacheAge >= api.ttl ? await api.read() : api.memory); } },
  E: { name: "Always revalidate", async run(api) { return execute(api, await api.read()); } },
  F: { name: "PREMiSE version", async run(api) {
    const observed = await api.read();
    const current = observed.version === api.memory.version ? observed : await api.read();
    return execute(api, current);
  } },
  G: { name: "PREMiSE dependencies", async run(api) {
    const dependency = await api.read();
    const current = dependency.version === api.memory.version ? dependency : await api.read();
    return execute(api, current);
  } },
  H: { name: "PREMiSE full", async run(api) {
    let observed = await api.read();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await execute(api, observed, true);
      if (response.accepted || observed.content.status === "blocked") return response;
      observed = await api.read();
    }
    return { accepted: false, reason: "retry-limit" };
  } }
};

export const baselineOrder = Object.keys(baselines);
