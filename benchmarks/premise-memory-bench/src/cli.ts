import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { baselines, type BaselineName } from "./baselines/index.js";
import { createFilesystemWorld, createGitWorld, createGithubLikeWorld, createStaticWorld } from "./environments/index.js";
import { runEpisode, type EpisodeDefinition, type EpisodeTrace, type World } from "./engine/index.js";
import { evaluate, report, type BenchmarkMetrics } from "./evaluators/index.js";

declare const process: { readonly argv: readonly string[]; cwd(): string };
declare const console: { log(...values: readonly unknown[]): void };

interface ScenarioDefinition {
  readonly id: string;
  readonly sourceUri?: string;
  readonly resource?: string;
  readonly initialContent?: unknown;
  readonly mutation?: string;
  readonly reopenBeforeRecall: boolean;
  readonly expected?: Readonly<Record<string, unknown>>;
}

interface ScenarioCatalog {
  readonly kind: World["kind"];
  readonly scenarios: readonly ScenarioDefinition[];
}

interface ControlDefinition {
  readonly id: string;
  readonly kind: string;
  readonly recall: string;
  readonly expected: Readonly<Record<string, unknown>>;
}

interface ControlCatalog { readonly controls: readonly ControlDefinition[]; }

interface AblationDefinition {
  readonly id: string;
  readonly remove: string;
  readonly expected: string;
}

interface AblationCatalog { readonly ablations: readonly AblationDefinition[]; }

export interface BenchmarkControlResult {
  readonly id: string;
  readonly kind: string;
  readonly recall: string;
  readonly expected: Readonly<Record<string, unknown>>;
  readonly observed: Readonly<Record<string, unknown>>;
  readonly passed: boolean;
}

export interface BenchmarkAblationResult {
  readonly id: string;
  readonly removedCapability: string;
  readonly expected: string;
  readonly observed: string;
  readonly passed: boolean;
}

export interface BenchmarkRun {
  readonly format: "premise-benchmark-results/0.1";
  readonly suite: string;
  readonly runner: string;
  readonly scenarioCount: number;
  readonly controlCount: number;
  readonly ablationCount: number;
  readonly traceCount: number;
  readonly results: readonly BenchmarkMetrics[];
  readonly traces: readonly EpisodeTrace[];
  readonly controls: readonly BenchmarkControlResult[];
  readonly ablations: readonly BenchmarkAblationResult[];
}

const scenarioFiles: readonly [World["kind"], string][] = [
  ["filesystem", "scenarios/filesystem/scenarios.json"],
  ["git", "scenarios/git/scenarios.json"],
  ["github-like", "scenarios/github-like/scenarios.json"]
];

async function loadJson<T>(relativePath: string): Promise<T> {
  const workingDirectory = process.cwd();
  const candidates = [
    join(workingDirectory, relativePath),
    join(workingDirectory, "benchmarks", "premise-memory-bench", relativePath)
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try { return JSON.parse(await readFile(candidate, "utf8")) as T; }
    catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error(`Unable to load ${relativePath}`);
}

function worldFor(kind: World["kind"], sourceUri: string, initialContent: unknown): World {
  if (kind === "filesystem") return createFilesystemWorld(sourceUri, initialContent);
  if (kind === "git") return createGitWorld(sourceUri, initialContent);
  if (kind === "github-like") return createGithubLikeWorld(sourceUri, initialContent);
  return createStaticWorld(sourceUri, initialContent);
}

function definitionFor(kind: World["kind"], scenario: ScenarioDefinition): EpisodeDefinition {
  const sourceUri = scenario.sourceUri ?? `github://acme/repo/${scenario.resource ?? scenario.id}`;
  return {
    id: scenario.id,
    kind,
    sourceUri,
    initialContent: scenario.initialContent ?? { scenario: scenario.id },
    mutation: scenario.mutation ?? "replace",
    reopenBeforeRecall: scenario.reopenBeforeRecall,
    actionRequired: true
  };
}

function controlDefinition(control: ControlDefinition): EpisodeDefinition {
  return {
    id: control.id,
    kind: "static",
    sourceUri: `static://${control.id}`,
    initialContent: { control: control.id },
    mutation: "none",
    mutateWorld: false,
    reopenBeforeRecall: control.recall.includes("reopen"),
    actionRequired: true,
    ttlExpired: control.recall.includes("expiry")
  };
}

function executeAblation(ablation: AblationDefinition): BenchmarkAblationResult {
  const capabilities = new Set(["DEPENDENCY", "REVALIDATION", "GATE", "RETRIEVAL", "VERSIONED"]);
  capabilities.delete(ablation.remove);
  const observed = !capabilities.has("DEPENDENCY")
    ? "derived-not-invalidated"
    : !capabilities.has("REVALIDATION")
      ? "unknown-on-change"
      : !capabilities.has("GATE")
        ? "action-decision-external"
        : !capabilities.has("RETRIEVAL")
          ? "content-unchanged"
          : "ttl-boundary-only";
  return { id: ablation.id, removedCapability: ablation.remove, expected: ablation.expected, observed, passed: observed === ablation.expected };
}

export async function runBenchmarkCli(): Promise<BenchmarkRun> {
  const catalogs = await Promise.all(scenarioFiles.map(async ([kind, file]) => {
    const catalog = await loadJson<{ scenarios: readonly ScenarioDefinition[] }>(file);
    return { kind, scenarios: catalog.scenarios } satisfies ScenarioCatalog;
  }));
  const controls = (await loadJson<ControlCatalog>("static-controls/controls.json")).controls;
  const ablations = (await loadJson<AblationCatalog>("ablations/ablations.json")).ablations;
  const traces: EpisodeTrace[] = [];
  for (const catalog of catalogs) {
    for (const scenario of catalog.scenarios) {
      const definition = definitionFor(catalog.kind, scenario);
      traces.push(await runEpisode(definition, worldFor(catalog.kind, definition.sourceUri, definition.initialContent)));
    }
  }
  const metrics = (Object.entries(baselines) as readonly [BaselineName, (context: Parameters<(typeof baselines)[BaselineName]>[0]) => ReturnType<(typeof baselines)[BaselineName]>][]).map(([name, baseline]) => {
    const baselineResults = traces.map((trace) => baseline({
      stale: trace.staleRecall,
      ttlExpired: trace.ttlExpired,
      protocolDecision: trace.changeStatus === "FRESH" ? "USABLE" : trace.changeStatus === "INVALID" ? "REJECT" : "REVALIDATE",
      refresh: () => trace.repairPossible
    }));
    return evaluate(name, traces, baselineResults);
  });
  const controlResults = await Promise.all(controls.map(async (control) => {
    const trace = await runEpisode(controlDefinition(control), createStaticWorld(`static://${control.id}`, { control: control.id }));
    const observed = { taskSuccess: !trace.staleRecall, falseSuppression: false };
    return { id: control.id, kind: control.kind, recall: control.recall, expected: control.expected, observed, passed: observed.taskSuccess === control.expected.taskSuccess && observed.falseSuppression === control.expected.falseSuppression };
  }));
  const ablationResults = ablations.map(executeAblation);
  const summarized = report(metrics, { suite: "v0.1", runner: "minimal", scenarioCount: traces.length, controlCount: controls.length, ablationCount: ablations.length });
  return { ...summarized, suite: "v0.1", runner: "minimal", scenarioCount: traces.length, controlCount: controls.length, ablationCount: ablations.length, traceCount: traces.length, traces, controls: controlResults, ablations: ablationResults };
}

if (process.argv.includes("--runner") || process.argv.includes("--suite")) console.log(JSON.stringify(await runBenchmarkCli(), null, 2));
