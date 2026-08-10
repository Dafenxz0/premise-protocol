import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "./postgres-scale.mjs";

test("real PostgreSQL scale harness requires an explicit mode and validates bounded configuration", () => {
  const previousUrl = process.env.DATABASE_URL;
  const previousMemories = process.env.PREMISE_SCALE_MEMORIES;
  try {
    process.env.DATABASE_URL = "postgresql://benchmark:benchmark@localhost:5432/premise";
    process.env.PREMISE_SCALE_MEMORIES = "100000";
    const parsed = parseArgs(["--mode", "benchmark", "--output", "report.json", "--trace", "traces.jsonl"]);
    assert.equal(parsed.config.mode, "benchmark");
    assert.equal(parsed.config.memories, 100_000);
    assert.equal(parsed.config.outputPath.endsWith("report.json"), true);
    assert.equal(parsed.config.tracePath.endsWith("traces.jsonl"), true);
    assert.throws(() => parseArgs(["--mode", "seed", "--unknown", "value"]), /unknown argument/);
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    if (previousMemories === undefined) delete process.env.PREMISE_SCALE_MEMORIES; else process.env.PREMISE_SCALE_MEMORIES = previousMemories;
  }
});

console.log("postgres-scale harness tests passed");
