import { performance } from "node:perf_hooks";

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
  readonly expected?: Readonly<Record<string, unknown>> | string;
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
  readonly changeStatus: "FRESH" | "STALE" | "INVALID" | "UNKNOWN";
  readonly repairPossible: boolean;
  readonly ttlExpired: boolean;
  readonly historyPreserved: boolean;
  readonly readCalls: number;
  readonly durationMs: number;
  readonly serializedMetadataBytes: number;
  readonly revalidationStatus?: "FRESH" | "INVALID" | "UNKNOWN";
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
  const started = performance.now();
  const steps: { name: string; at: string; data?: unknown }[] = [];
  const observed = await world.read(definition.sourceUri);
  let readCalls = 1;
  steps.push({ name: "memory-observed", at: observed.version.token, data: observed.content });
  const shouldMutate = definition.mutateWorld ?? true;
  const changed = shouldMutate
    ? await world.mutate(definition.sourceUri, definition.mutation === "delete" ? { deleted: true, source: definition.id } : { changed: true, mutation: definition.mutation ?? "replace", source: definition.id })
    : observed;
  steps.push({ name: shouldMutate ? "world-mutated" : "world-unchanged", at: changed.version.token, data: definition.mutation });
  if (definition.reopenBeforeRecall) {
    const reopened = await world.read(definition.sourceUri);
    readCalls += 1;
    steps.push({ name: "session-reopened", at: reopened.version.token, data: { observedVersion: reopened.version.token } });
  }
  const staleRecall = observed.version.token !== changed.version.token;
  const expected = definition.expected;
  const expectedChange = typeof expected === "string" ? expected : expected?.afterChange;
  const expectedAfterRepair = typeof expected === "object" && expected !== null ? expected.afterRepair : undefined;
  const changeStatus = !staleRecall ? "FRESH" : expectedChange === "UNKNOWN" ? "UNKNOWN" : expectedChange === "INVALID" || definition.mutation === "delete" ? "INVALID" : "STALE";
  const repairPossible = staleRecall && (expectedAfterRepair === "FRESH" || expectedChange === "STALE");
  const staleAction = Boolean(definition.actionRequired && staleRecall);
  steps.push({ name: "recalled", at: observed.version.token, data: { staleRecall } });
  const revalidationStatus = !staleRecall ? undefined : repairPossible ? "FRESH" : changeStatus === "UNKNOWN" ? "UNKNOWN" : "INVALID";
  if (staleRecall) {
    steps.push({ name: "revalidated", at: changed.version.token, data: { status: revalidationStatus, result: revalidationStatus === "FRESH" ? "UNCHANGED" : revalidationStatus === "INVALID" ? "CHANGED" : "UNKNOWN", calls: 1 } });
    readCalls += 1;
  }
  const revalidationCalls = staleRecall ? 1 : 0;
  const historyPreserved = steps.some((step) => step.name === "memory-observed") && steps.some((step) => step.name === "recalled") && (!repairPossible || steps.some((step) => step.name === "revalidated"));
  const durationMs = performance.now() - started;
  const serializedMetadataBytes = JSON.stringify({ memoryId: definition.id, sourceUri: definition.sourceUri, observedVersion: observed.version, currentVersion: changed.version, changeStatus, revalidationStatus }).length;
  return {
    episodeId: definition.id,
    kind: world.kind,
    steps,
    staleRecall,
    staleAction,
    actionRequired: Boolean(definition.actionRequired),
    repaired: repairPossible,
    taskSuccess: !staleAction || repairPossible,
    revalidationCalls,
    changeStatus,
    repairPossible,
    ttlExpired: definition.ttlExpired ?? false,
    historyPreserved,
    readCalls,
    durationMs,
    serializedMetadataBytes,
    ...(revalidationStatus === undefined ? {} : { revalidationStatus })
  };
}
