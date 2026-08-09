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
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly memoryP50Bytes: number;
  readonly memoryP95Bytes: number;
  readonly decisionTrace: readonly {
    readonly episodeId: string;
    readonly status: string;
    readonly decision: string;
    readonly repaired: boolean;
    readonly revalidationCalls: number;
    readonly safe: boolean;
  }[];
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

export function evaluate(baseline: BaselineName, traces: readonly EpisodeTrace[], results: readonly BaselineResult[]): BenchmarkMetrics {
  const total = Math.max(1, traces.length);
  const dynamic = traces.filter((trace) => trace.actionRequired);
  const dynamicTotal = Math.max(1, dynamic.length);
  const decisionTrace = traces.map((trace, index) => {
    const result = results[index];
    const safe = !trace.staleAction || result?.decision !== "USE" || Boolean(result?.repaired);
    return {
      episodeId: trace.episodeId,
      status: trace.changeStatus,
      decision: result?.decision ?? "REJECT",
      repaired: Boolean(result?.repaired),
      revalidationCalls: result?.revalidationCalls ?? 0,
      safe
    };
  });
  return {
    baseline,
    episodes: traces.length,
    staleRecallRate: traces.filter((trace) => trace.staleRecall).length / total,
    staleActionRate: traces.filter((trace, index) => trace.staleAction && results[index]?.decision === "USE" && !results[index]?.repaired).length / total,
    dynamicMemoryRepairRate: dynamic.length === 0 ? 0 : traces.reduce((count, trace, index) => count + (trace.actionRequired && results[index]?.repaired ? 1 : 0), 0) / dynamicTotal,
    taskSuccessRate: traces.reduce((successes, trace, index) => successes + (!trace.actionRequired ? 1 : !trace.staleRecall ? (results[index]?.decision === "USE" ? 1 : 0) : (trace.repairPossible ? (results[index]?.decision === "USE" && Boolean(results[index]?.repaired) ? 1 : 0) : 0)), 0) / total,
    falseSuppressionRate: traces.reduce((suppressed, trace, index) => suppressed + (!trace.staleRecall && results[index]?.decision === "REJECT" ? 1 : 0), 0) / total,
    revalidationCalls: results.reduce((sum, result) => sum + result.revalidationCalls, 0),
    historyPreservationRate: traces.filter((trace) => trace.historyPreserved).length / total,
    latencyP50Ms: percentile(traces.map((trace) => trace.durationMs), 0.5),
    latencyP95Ms: percentile(traces.map((trace) => trace.durationMs), 0.95),
    memoryP50Bytes: percentile(traces.map((trace) => trace.serializedMetadataBytes), 0.5),
    memoryP95Bytes: percentile(traces.map((trace) => trace.serializedMetadataBytes), 0.95),
    decisionTrace
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
