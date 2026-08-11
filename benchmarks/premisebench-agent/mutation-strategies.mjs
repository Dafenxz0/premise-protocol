// Guarded adapters receive the version in actIfVersion's first argument. They
// attach basedOnVersion only after CAS accepts, so PREMiSE does not serialize
// the same version token in both the guard and the action. Unguarded baselines
// keep the field because their evaluator needs the observed version.
function actionFor(snapshot, includeVersion = true) {
  if (snapshot.content.status === "blocked") {
    return { kind: "reject" };
  }
  const action = { kind: "apply", value: snapshot.content.value };
  return includeVersion ? { ...action, basedOnVersion: snapshot.version } : action;
}

// The connector does not need a prose reason for a read. Keep the same
// compact reason vocabulary for every arm so the token proxy does not reward
// an implementation merely for using shorter metadata.
const READ_REVALIDATE = "revalidate";
const READ_RETRY_AFTER_CAS = "retry";

export const mutationStrategies = Object.freeze({
  basic: {
    name: "Memoria básica",
    description: "Confía en la observación inicial y actúa sin comprobar la fuente.",
    async run(ctx) {
      return ctx.act(actionFor(ctx.memory));
    }
  },
  conventional: {
    name: "Memoria mejorada convencional",
    description: "Vuelve a leer la fuente antes de actuar, pero no protege el write contra TOCTOU.",
    async run(ctx) {
      const current = await ctx.sourceRead(READ_REVALIDATE);
      return ctx.act(actionFor(current));
    }
  },
  premise: {
    name: "PREMiSE",
    description: "Comprueba localmente la evidencia, revalida solo si está obsoleta y usa CAS al escribir.",
    async run(ctx) {
      const check = ctx.checkEvidence();
      let current = ctx.memory;
      if (check.state !== "FRESH") current = await ctx.sourceRead(READ_REVALIDATE);
      if (current.content.status === "blocked") return { accepted: true, kind: "reject" };

      let response = await ctx.actIfVersion(current.version, actionFor(current, false));
      if (!response.accepted) {
        current = await ctx.sourceRead(READ_RETRY_AFTER_CAS);
        if (current.content.status === "blocked") return { accepted: true, kind: "reject" };
        response = await ctx.actIfVersion(current.version, actionFor(current, false));
      }
      return response;
    }
  }
});

export const mutationArmOrder = Object.freeze(["basic", "conventional", "premise"]);

async function guardedWithRetry(ctx, snapshot, attempts = 3) {
  let current = snapshot;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // A blocked source is already a terminal safe outcome. Do not spend a
    // connector write just to confirm a rejection; this keeps the strong
    // Smart/Always controls from being artificially inflated against PREMiSE.
    if (current.content.status === "blocked") return { accepted: true, kind: "reject" };
    const response = await ctx.actIfVersion(current.version, actionFor(current, false));
    if (response.accepted) return response;
    current = await ctx.sourceRead(READ_RETRY_AFTER_CAS);
    if (current.content.status === "blocked") return { accepted: true, kind: "reject" };
  }
  return { accepted: false, reason: "retry-limit" };
}

// Scientific MVP arms deliberately share the same connector capabilities.
// Smart Revalidate has versions, events, CAS and retries, but no PREMiSE
// dependency graph or normative state machine. The `perfect` arm is a
// deterministic no-LLM control, not a commercial competitor.
export const scientificStrategies = Object.freeze({
  basic: mutationStrategies.basic,
  conventional: mutationStrategies.conventional,
  smart: {
    name: "Smart Revalidate",
    description: "Versiones, eventos, cache y CAS sin grafo normativo PREMiSE.",
    async run(ctx) {
      const changed = ctx.sourceChanged();
      const current = changed ? await ctx.sourceRead(READ_REVALIDATE) : ctx.memory;
      return guardedWithRetry(ctx, current, 2);
    }
  },
  always: {
    name: "Always Revalidate",
    description: "Lee y valida antes de cada accion, con CAS y reintentos.",
    async run(ctx) {
      const current = await ctx.sourceRead(READ_REVALIDATE);
      return guardedWithRetry(ctx, current, 3);
    }
  },
  premise: mutationStrategies.premise,
  perfect: {
    name: "Deterministic perfect agent",
    description: "Control sin LLM que ejecuta la secuencia correcta con CAS.",
    async run(ctx) {
      let current = await ctx.sourceRead(READ_REVALIDATE);
      return guardedWithRetry(ctx, current, 4);
    }
  }
});

export const scientificArmOrder = Object.freeze(["basic", "conventional", "smart", "always", "premise", "perfect"]);
