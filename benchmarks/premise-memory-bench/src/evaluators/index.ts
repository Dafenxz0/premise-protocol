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
  return {
    baseline,
    episodes: traces.length,
    staleRecallRate: traces.filter((trace) => trace.staleRecall).length / total,
    staleActionRate: traces.filter((trace, index) => trace.staleAction && results[index]?.decision === "USE" && !results[index]?.repaired).length / total,
    dynamicMemoryRepairRate: results.filter((result) => result.repaired).length / total,
    taskSuccessRate: traces.reduce((successes, trace, index) => successes + (!trace.actionRequired ? 1 : !trace.staleRecall ? (results[index]?.decision === "USE" ? 1 : 0) : (results[index]?.decision === "USE" && trace.changeStatus !== "INVALID" && (results[index]?.repaired || !trace.repairPossible) ? 1 : 0)), 0) / total,
    falseSuppressionRate: traces.reduce((suppressed, trace, index) => suppressed + (!trace.staleRecall && results[index]?.decision === "REJECT" ? 1 : 0), 0) / total,
    revalidationCalls: results.reduce((sum, result) => sum + result.revalidationCalls, 0),
    historyPreservationRate: traces.filter((trace) => trace.historyPreserved).length / total
  };
}

export interface BenchmarkReportMetadata {
  readonly suite?: string;
  readonly runner?: string;
  readonly scenarioCount?: number;
  readonly controlCount?: number;
  readonly ablationCount?: number;
}

export function report(metrics: readonly BenchmarkMetrics[], metadata: BenchmarkReportMetadata = {}): { readonly format: "premise-benchmark-results/0.1"; readonly results: readonly BenchmarkMetrics[] } & BenchmarkReportMetadata {
  return { format: "premise-benchmark-results/0.1", ...metadata, results: metrics.map((metric) => JSON.parse(JSON.stringify(metric)) as BenchmarkMetrics) };
}
