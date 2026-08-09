import type { BaselineName, BaselineResult } from "../baselines/index.js";
import type { EpisodeTrace } from "../engine/index.js";

export interface BenchmarkMetrics {
  readonly baseline: BaselineName;
  readonly episodes: number;
  readonly staleRecallRate: number;
  readonly staleActionRate: number;
  readonly dynamicMemoryRepairRate: number;
  readonly taskSuccessRate: number;
  readonly falseSuppressionRate: number;
  readonly revalidationCalls: number;
  readonly historyPreservationRate: number;
}

export function evaluate(baseline: BaselineName, traces: readonly EpisodeTrace[], results: readonly BaselineResult[]): BenchmarkMetrics {
  const total = Math.max(1, traces.length);
  const suppressed = results.filter((result) => result.decision === "REJECT").length;
  return {
    baseline,
    episodes: traces.length,
    staleRecallRate: traces.filter((trace) => trace.staleRecall).length / total,
    staleActionRate: traces.filter((trace, index) => trace.staleAction && results[index]?.decision === "USE" && !results[index]?.repaired).length / total,
    dynamicMemoryRepairRate: results.filter((result) => result.repaired).length / total,
    taskSuccessRate: traces.reduce((successes, trace, index) => successes + (!trace.staleAction || results[index]?.repaired || results[index]?.decision === "REJECT" ? 1 : 0), 0) / total,
    falseSuppressionRate: Math.max(0, suppressed - traces.filter((trace) => trace.staleRecall).length) / total,
    revalidationCalls: results.reduce((sum, result) => sum + result.revalidationCalls, 0),
    historyPreservationRate: traces.every((trace) => trace.steps.length > 0) ? 1 : 0
  };
}

export function report(metrics: readonly BenchmarkMetrics[]): { readonly format: "premise-benchmark-results/0.1"; readonly results: readonly BenchmarkMetrics[] } {
  return { format: "premise-benchmark-results/0.1", results: metrics.map((metric) => JSON.parse(JSON.stringify(metric)) as BenchmarkMetrics) };
}
