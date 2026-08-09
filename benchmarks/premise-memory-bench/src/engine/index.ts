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
  readonly reopenBeforeRecall?: boolean;
  readonly actionRequired?: boolean;
}

export interface EpisodeTrace {
  readonly episodeId: string;
  readonly kind: World["kind"];
  readonly steps: readonly { readonly name: string; readonly at: string; readonly data?: unknown }[];
  readonly staleRecall: boolean;
  readonly staleAction: boolean;
  readonly repaired: boolean;
  readonly taskSuccess: boolean;
  readonly revalidationCalls: number;
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
  const changed = await world.mutate(definition.sourceUri, { changed: true, source: definition.id });
  steps.push({ name: "world-mutated", at: changed.version.token });
  if (definition.reopenBeforeRecall) steps.push({ name: "session-reopened", at: changed.version.token });
  const staleRecall = observed.version.token !== changed.version.token;
  const staleAction = Boolean(definition.actionRequired && staleRecall);
  steps.push({ name: "recalled", at: observed.version.token, data: { staleRecall } });
  return { episodeId: definition.id, kind: world.kind, steps, staleRecall, staleAction, repaired: !staleRecall, taskSuccess: !staleAction, revalidationCalls: 0 };
}
