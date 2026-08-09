export type BaselineName = "Plain Memory" | "Prompt Recheck" | "TTL Memory" | "Always Refresh" | "PREMiSE Explicit";
export type BaselineDecision = "USE" | "RECHECK" | "REJECT";

export interface BaselineContext {
  readonly stale: boolean;
  readonly ttlExpired?: boolean;
  readonly protocolDecision?: "USABLE" | "REVALIDATE" | "REJECT";
  readonly refresh: () => boolean;
}

export interface BaselineResult {
  readonly name: BaselineName;
  readonly decision: BaselineDecision;
  readonly revalidationCalls: number;
  readonly repaired: boolean;
}

export type Baseline = (context: BaselineContext) => BaselineResult;

export const baselines: Readonly<Record<BaselineName, Baseline>> = {
  "Plain Memory": () => ({ name: "Plain Memory", decision: "USE", revalidationCalls: 0, repaired: false }),
  "Prompt Recheck": (context) => context.stale ? { name: "Prompt Recheck", decision: context.refresh() ? "USE" : "REJECT", revalidationCalls: 1, repaired: true } : { name: "Prompt Recheck", decision: "USE", revalidationCalls: 0, repaired: false },
  "TTL Memory": (context) => context.ttlExpired ? { name: "TTL Memory", decision: "RECHECK", revalidationCalls: 0, repaired: false } : { name: "TTL Memory", decision: "USE", revalidationCalls: 0, repaired: false },
  "Always Refresh": (context) => ({ name: "Always Refresh", decision: context.refresh() ? "USE" : "REJECT", revalidationCalls: 1, repaired: context.stale }),
  "PREMiSE Explicit": (context) => context.protocolDecision === "USABLE" ? { name: "PREMiSE Explicit", decision: "USE", revalidationCalls: 0, repaired: false } : context.protocolDecision === "REJECT" ? { name: "PREMiSE Explicit", decision: "REJECT", revalidationCalls: 0, repaired: false } : { name: "PREMiSE Explicit", decision: context.refresh() ? "USE" : "REJECT", revalidationCalls: 1, repaired: true }
};
