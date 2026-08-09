export interface WorldObservation {
  readonly sourceUri: string;
  readonly version: { readonly scheme: string; readonly token: string };
  readonly content: unknown;
}

export interface World {
  readonly kind: "filesystem" | "git" | "github-like" | "static";
  read(sourceUri: string): Promise<WorldObservation>;
  mutate(sourceUri: string, content: unknown): Promise<WorldObservation>;
  snapshot(): Readonly<Record<string, WorldObservation>>;
}

export interface EpisodeDefinition {
  readonly id: string;
  readonly sourceUri: string;
  readonly kind?: World["kind"];
  readonly initialContent?: unknown;
  readonly mutation?: string;
  readonly mutateWorld?: boolean;
  readonly reopenBeforeRecall?: boolean;
  readonly actionRequired?: boolean;
  readonly ttlExpired?: boolean;
}

export interface EpisodeTrace {
  readonly episodeId: string;
  readonly kind: World["kind"];
  readonly steps: readonly { readonly name: string; readonly at: string; readonly data?: unknown }[];
  readonly staleRecall: boolean;
  readonly staleAction: boolean;
  readonly actionRequired: boolean;
  readonly repaired: boolean;
  readonly taskSuccess: boolean;
  readonly revalidationCalls: number;
  readonly changeStatus: "FRESH" | "STALE" | "INVALID";
  readonly repairPossible: boolean;
  readonly ttlExpired: boolean;
  readonly historyPreserved: boolean;
}

export type EpisodeRunner = (definition: EpisodeDefinition, world: World) => Promise<EpisodeTrace>;

export class DeterministicScheduler {
  async run(definitions: readonly EpisodeDefinition[], world: World, runner: EpisodeRunner): Promise<readonly EpisodeTrace[]> {
    const traces: EpisodeTrace[] = [];
    for (const definition of definitions) traces.push(await runner(definition, world));
    return traces;
  }
}

export async function runEpisode(definition: EpisodeDefinition, world: World): Promise<EpisodeTrace> {
  const steps: { name: string; at: string; data?: unknown }[] = [];
  const observed = await world.read(definition.sourceUri);
  steps.push({ name: "memory-observed", at: observed.version.token, data: observed.content });
  const shouldMutate = definition.mutateWorld ?? true;
  const changed = shouldMutate
    ? await world.mutate(definition.sourceUri, definition.mutation === "delete" ? { deleted: true, source: definition.id } : { changed: true, mutation: definition.mutation ?? "replace", source: definition.id })
    : observed;
  steps.push({ name: shouldMutate ? "world-mutated" : "world-unchanged", at: changed.version.token, data: definition.mutation });
  if (definition.reopenBeforeRecall) steps.push({ name: "session-reopened", at: changed.version.token });
  const staleRecall = observed.version.token !== changed.version.token;
  const changeStatus = !staleRecall ? "FRESH" : definition.mutation === "delete" ? "INVALID" : "STALE";
  const repairPossible = staleRecall && changeStatus !== "INVALID";
  const staleAction = Boolean(definition.actionRequired && staleRecall);
  steps.push({ name: "recalled", at: observed.version.token, data: { staleRecall } });
  return {
    episodeId: definition.id,
    kind: world.kind,
    steps,
    staleRecall,
    staleAction,
    actionRequired: Boolean(definition.actionRequired),
    repaired: !staleRecall,
    taskSuccess: !staleAction,
    revalidationCalls: 0,
    changeStatus,
    repairPossible,
    ttlExpired: definition.ttlExpired ?? false,
    historyPreserved: steps.some((step) => step.name === "memory-observed") && steps.some((step) => step.name === "recalled")
  };
}
