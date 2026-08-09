import type {
  Capability,
  CapabilitiesDeclaration,
  MemoryEnvelope,
  PremiseEvent,
  ValidationResult,
  UsabilityDecision
} from "@premise/protocol-types";
export * from "./vectors.js";

export const REQUIRED_CAPABILITIES = ["RECORD", "DEPENDENCY", "REVALIDATION"] as const satisfies readonly Capability[];

export interface ConformanceAdapter {
  readonly capabilities: CapabilitiesDeclaration;
  register(envelope: MemoryEnvelope): Promise<void> | void;
  derive(envelope: MemoryEnvelope): Promise<void> | void;
  signal(event: PremiseEvent): Promise<unknown> | unknown;
  validate(memoryIds: readonly string[]): Promise<readonly ValidationResult[]> | readonly ValidationResult[];
  check(memoryIds: readonly string[]): Promise<readonly { memoryId: string; decision: UsabilityDecision }[]> | readonly { memoryId: string; decision: UsabilityDecision }[];
  history(memoryId: string): Promise<readonly PremiseEvent[]> | readonly PremiseEvent[];
}

export interface ConformanceStep {
  readonly id: string;
  readonly operation: keyof Pick<ConformanceAdapter, "register" | "derive" | "signal" | "validate" | "check" | "history">;
  readonly input?: unknown;
  readonly expect?: unknown;
}

export interface ConformanceCase {
  readonly id: string;
  readonly steps: readonly ConformanceStep[];
}

export interface ConformanceCaseResult {
  readonly id: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export interface ConformanceReport {
  readonly format: "premise-conformance-report/0.1";
  readonly passed: boolean;
  readonly total: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly results: readonly ConformanceCaseResult[];
}

export function missingRequiredCapabilities(declared: readonly Capability[]): readonly Capability[] {
  return REQUIRED_CAPABILITIES.filter((capability) => !declared.includes(capability));
}

export function assertConformanceCapabilities(adapter: Pick<ConformanceAdapter, "capabilities">): void {
  const missing = missingRequiredCapabilities(adapter.capabilities.capabilities);
  if (missing.length > 0) throw new Error(`Adapter lacks required PREMiSE capabilities: ${missing.join(", ")}`);
}

function matchesExpectation(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => matchesExpectation(actual[index], item));
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) => matchesExpectation((actual as Record<string, unknown>)[key], value));
}

export async function runConformance(adapter: ConformanceAdapter, cases: readonly ConformanceCase[]): Promise<ConformanceReport> {
  assertConformanceCapabilities(adapter);
  const results: ConformanceCaseResult[] = [];
  for (const testCase of cases) {
    const failures: string[] = [];
    for (const step of testCase.steps) {
      try {
        const actual = await adapter[step.operation](step.input as never);
        if (!matchesExpectation(actual, step.expect)) failures.push(`${step.id}: expectation did not match`);
      } catch (error) {
        failures.push(`${step.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    results.push({ id: testCase.id, passed: failures.length === 0, failures });
  }
  const passedCount = results.filter((result) => result.passed).length;
  return { format: "premise-conformance-report/0.1", passed: passedCount === results.length, total: results.length, passedCount, failedCount: results.length - passedCount, results };
}
