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

// The connector does not need a prose reason for a read.  The operation
// itself and the version carried by the snapshot already identify why the
// read is happening, so use stable compact reason codes in the external
// envelope.  Keep the codes explicit rather than omitting the field so the
// trace remains auditable and comparable across arms.
const READ_REVALIDATE = 0;
const READ_RETRY_AFTER_CAS = 1;

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
      const current = await ctx.sourceRead("refresh-before-action");
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
