import assert from "node:assert/strict";
import { ContextEngine, chunkText, selectContext } from "../dist/index.js";

const wordTokens = (text) => text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;

{
  const chunks = chunkText("one two three four five six seven eight", 3, wordTokens);
  assert.deepEqual(chunks, ["one two three", "four five six", "seven eight"]);
  assert.ok(chunks.every((chunk) => wordTokens(chunk) <= 3));
}

{
  const candidates = Array.from({ length: 512 }, (_, index) => ({
    id: `memory-${index}`,
    topic: `topic-${index % 16}`,
    content: Array.from({ length: 250 }, (_, token) => `t${index}-${token}`).join(" "),
    relevance: index % 7 === 0 ? 1 : 0.5
  }));
  const result = selectContext({
    candidates,
    tokenBudget: 128_000,
    reservedTokens: 256,
    chunkSizeTokens: 256,
    tokenEstimator: wordTokens
  });
  assert.equal(result.tokenBudget, 128_000);
  assert.equal(result.usableTokenBudget, 127_744);
  assert.ok(result.tokensUsed <= result.usableTokenBudget);
  assert.equal(result.tokensUsed + result.remainingTokens, result.usableTokenBudget);
  assert.equal(new Set(result.selected.map((chunk) => chunk.id)).size, result.selected.length);
  assert.equal(result.stats.candidateCount, 512);
  assert.ok(result.stats.selectedTopicCount >= 2);
  assert.ok(result.degraded);
  assert.ok(result.degradationReasons.includes("token-budget"));
  assert.equal(result.trace.length, result.stats.chunkCount);
}

{
  const result = selectContext({
    tokenBudget: 10,
    chunkSizeTokens: 4,
    tokenEstimator: wordTokens,
    candidates: [{ id: "large", content: "a b c d e f g h i j k l" }]
  });
  assert.ok(result.tokensUsed <= 10);
  assert.ok(result.selected.length > 0);
  assert.ok(result.omitted.some((entry) => entry.reason === "budget"));
  assert.ok(result.trace.filter((entry) => entry.decision === "selected").every((entry) => entry.tokens <= 4));
  assert.throws(() => selectContext({ tokenBudget: 0, candidates: [] }), /positive integer/);
  assert.throws(() => selectContext({ tokenBudget: 8, reservedTokens: 9, candidates: [] }), /cannot exceed/);
  assert.throws(() => selectContext({ tokenBudget: 8, chunkSizeTokens: 0, candidates: [] }), /positive integer/);
}

{
  const byChunkLimit = selectContext({
    tokenBudget: 20,
    maxChunks: 1,
    chunkSizeTokens: 20,
    tokenEstimator: wordTokens,
    candidates: [
      { id: "first", content: "first" },
      { id: "second", content: "second" }
    ]
  });
  assert.equal(byChunkLimit.selected.length, 1);
  assert.ok(byChunkLimit.omitted.some((entry) => entry.reason === "max-chunks"));

  const bySourceLimit = selectContext({
    tokenBudget: 20,
    maxSources: 1,
    chunkSizeTokens: 20,
    tokenEstimator: wordTokens,
    candidates: [
      { id: "source-a", content: "a" },
      { id: "source-b", content: "b" }
    ]
  });
  assert.equal(bySourceLimit.stats.selectedSourceCount, 1);
  assert.ok(bySourceLimit.omitted.some((entry) => entry.reason === "max-sources"));
  assert.ok(bySourceLimit.degradationReasons.includes("limits"));
}

{
  const result = new ContextEngine({ tokenEstimator: wordTokens }).select({
    tokenBudget: 20,
    chunkSizeTokens: 20,
    candidates: [
      { id: "fresh-summary", kind: "summary", topic: "project", content: "current plan" },
      { id: "stale-detail", kind: "detail", parentId: "fresh-summary", topic: "project", freshness: "STALE", content: "old implementation detail" },
      { id: "invalid", freshness: "INVALID", content: "must never enter context" },
      { id: "obsolete", status: "OBSOLETE", content: "obsolete memory" }
    ]
  });
  assert.deepEqual(result.selected.map((chunk) => chunk.id), ["fresh-summary"]);
  assert.ok(result.omitted.some((entry) => entry.id === "stale-detail" && entry.reason === "stale"));
  assert.ok(result.omitted.some((entry) => entry.id === "invalid" && entry.reason === "invalid-freshness"));
  assert.ok(result.omitted.some((entry) => entry.id === "obsolete" && entry.reason === "stale"));
  assert.ok(result.degradationReasons.includes("freshness-gate"));
}

{
  const result = selectContext({
    tokenBudget: 30,
    chunkSizeTokens: 30,
    tokenEstimator: wordTokens,
    candidates: [
      { id: "a-summary", kind: "summary", topic: "a", content: "a summary", score: 1 },
      { id: "a-detail", kind: "detail", parentId: "a-summary", topic: "a", content: "a detail", score: 1 },
      { id: "b-summary", kind: "summary", topic: "b", content: "b summary", score: 1 },
      { id: "b-detail", kind: "detail", parentId: "b-summary", topic: "b", content: "b detail", score: 1 },
      { id: "duplicate", topic: "a", content: "a summary", score: 0.1 }
    ]
  });
  assert.deepEqual(result.selected.slice(0, 2).map((chunk) => chunk.id), ["a-summary", "b-summary"]);
  assert.ok(result.selected.findIndex((chunk) => chunk.id === "a-summary") < result.selected.findIndex((chunk) => chunk.id === "a-detail"));
  assert.ok(result.selected.findIndex((chunk) => chunk.id === "b-summary") < result.selected.findIndex((chunk) => chunk.id === "b-detail"));
  assert.ok(result.omitted.some((entry) => entry.id === "duplicate" && entry.reason === "duplicate" && entry.duplicateOf === "a-summary"));
  assert.ok(result.degradationReasons.includes("deduplication"));
}

{
  let estimateCalls = 0;
  const result = selectContext({
    tokenBudget: 20,
    chunkSizeTokens: 20,
    tokenEstimator: (text) => {
      estimateCalls += 1;
      return wordTokens(text);
    },
    candidates: [
      { id: "fresh-a", content: "same fresh context" },
      { id: "fresh-b", content: "same fresh context" }
    ]
  });
  assert.deepEqual(result.selected.map((chunk) => chunk.id), ["fresh-a"]);
  assert.equal(estimateCalls, 1);
  assert.ok(result.omitted.some((entry) => entry.id === "fresh-b" && entry.reason === "duplicate"));
}

{
  let estimateCalls = 0;
  const candidates = Array.from({ length: 3_000 }, (_, index) => ({
    id: `scale-${index}`,
    topic: `topic-${index % 32}`,
    content: "shared context for scale testing"
  }));
  const result = selectContext({
    candidates,
    tokenBudget: 64,
    chunkSizeTokens: 64,
    tokenEstimator: (text) => {
      estimateCalls += 1;
      return wordTokens(text);
    }
  });
  assert.equal(result.stats.candidateCount, 3_000);
  assert.equal(result.stats.chunkCount, 3_000);
  assert.equal(result.trace.length, 3_000);
  assert.equal(result.selected.length, 1);
  assert.equal(estimateCalls, 1);
}

{
  let estimateCalls = 0;
  const candidates = Array.from({ length: 4096 }, (_, index) => ({
    id: `scale-${index}`,
    topic: `topic-${index % 32}`,
    dedupeKey: `scale-${index}`,
    content: `shared context ${index % 32}`,
    score: (index % 11) / 10
  }));
  const request = {
    candidates,
    tokenBudget: 128,
    chunkSizeTokens: 8,
    freshnessGate: { now: "2026-08-10T00:00:00.000Z" },
    tokenEstimator: (text) => {
      estimateCalls += 1;
      return wordTokens(text);
    }
  };
  const result = selectContext(request);
  const reference = selectContext({ ...request, tokenEstimator: wordTokens });
  assert.deepEqual(result, reference);
  assert.equal(estimateCalls, 32);
  assert.equal(result.stats.candidateCount, 4096);
  assert.equal(result.trace.length, 4096);
  assert.ok(result.selected.length > 0);
}

{
  const result = selectContext({
    tokenBudget: 12,
    chunkSizeTokens: 12,
    tokenEstimator: wordTokens,
    freshnessGate: { allowStaleSummaries: true },
    candidates: [{ id: "memory", summary: "old summary", freshness: "STALE", content: "old detail" }]
  });
  assert.deepEqual(result.selected.map((chunk) => chunk.id), ["memory:summary"]);
  assert.equal(result.selected[0].freshness, "STALE");
  assert.ok(result.omitted.some((entry) => entry.id === "memory" && entry.reason === "stale"));
}

{
  const result = selectContext({
    tokenBudget: 10,
    chunkSizeTokens: 10,
    tokenEstimator: wordTokens,
    freshnessGate: { allowStaleSummaries: true, now: "2026-08-10T00:00:00.000Z" },
    candidates: [{ id: "expired-summary", kind: "summary", content: "expired summary", expiresAt: "2026-08-09T00:00:00.000Z" }]
  });
  assert.deepEqual(result.selected.map((chunk) => chunk.id), ["expired-summary"]);
  assert.equal(result.selected[0].freshness, "STALE");
  assert.equal(result.trace[0].freshness, "STALE");
}

console.log("context-engine tests passed");
