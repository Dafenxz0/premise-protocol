import assert from "node:assert/strict";
import test from "node:test";
import {
  DECISIONS,
  FORBIDDEN_FIELD_NAMES,
  GENESIS_HASH,
  ISOLATION_PROTOCOL,
  assertHashChain,
  assertNoForbiddenFields,
  canonicalJson,
  chainHash,
  coordinate,
  encodeNdjson,
  findForbiddenFields,
  hashChain,
  parseNdjson,
  runCandidate,
  sha256Json,
  validateCandidateOutputRecord
} from "./index.mjs";

test("canonical JSON sorts every object level and hash helpers bind a tamper-evident chain", () => {
  assert.equal(canonicalJson({ z: { b: 2, a: 1 }, a: [{ d: 4, c: 3 }] }), '{"a":[{"c":3,"d":4}],"z":{"a":1,"b":2}}');
  assert.equal(sha256Json({ b: 2, a: 1 }), sha256Json({ a: 1, b: 2 }));
  assert.notEqual(sha256Json({ b: 2 }), sha256Json({ b: 3 }));

  const chain = hashChain([{ id: "one", value: 1 }, { id: "two", value: 2 }]);
  assert.equal(chain[0].previousHash, GENESIS_HASH);
  assert.equal(chain[1].previousHash, chain[0].hash);
  assert.equal(chainHash(chain[0].previousHash, { id: "one", value: 1 }), chain[0].hash);
  assert.equal(assertHashChain(chain), chain);
  assert.deepEqual(assertHashChain(chain.map((entry) => ({ ...entry }))), chain);
  assert.deepEqual(chain, hashChain([{ value: 1, id: "one" }, { value: 2, id: "two" }]));
  const tampered = chain.map((entry) => ({ ...entry }));
  tampered[1].value = 99;
  assert.throws(() => assertHashChain(tampered), /invalid SHA-256 hash chain/iu);
});

test("NDJSON is object-per-line, bounded, and can require canonical sorted records", () => {
  const records = [{ type: "task", public: { b: 2, a: 1 } }, { type: "done" }];
  const encoded = records.map((record) => encodeNdjson(record)).join("");
  assert.deepEqual(parseNdjson(encoded, { requireCanonical: true }), records);
  assert.deepEqual(parseNdjson(encoded.replaceAll("\n", "\r\n"), { requireCanonical: true }), records);
  assert.throws(() => parseNdjson(`${encoded}\n`), /blank|empty/iu);
  assert.throws(() => parseNdjson('{"type":"task"}\n\n'), /blank/iu);
  assert.throws(() => parseNdjson('[1,2]\n'), /object/iu);
  assert.throws(() => parseNdjson('{"type":"task"} trailing\n'), /invalid NDJSON JSON/iu);
  assert.throws(() => parseNdjson('{"b":2,"a":1}\n', { requireCanonical: true }), /canonical/iu);
});

test("every forbidden evaluator field is caught recursively inside candidate plans", () => {
  for (const key of FORBIDDEN_FIELD_NAMES) {
    assert.throws(
      () => validateCandidateOutputRecord({ type: "plan", plan: { decision: "USE", trace: [{ nested: { [key]: true } }] } }),
      /forbidden evaluator field/iu,
      `forbidden key ${key} must be rejected`
    );
  }
  assert.deepEqual(findForbiddenFields({ plan: [{ safe: true }, { nested: { expected_decision: "REJECT" } }] }), [
    { path: "$.plan[1].nested.expected_decision", key: "expected_decision" }
  ]);
  assert.throws(() => assertNoForbiddenFields({ plan: { decision: "USE", action: { mapping: "private" } } }), /forbidden/iu);
  assert.throws(() => validateCandidateOutputRecord({ type: "plan", plan: { decision: "MAYBE" } }), /one of USE/iu);
});

test("coordinator sends only the public payload and runs the candidate without a shell", async () => {
  const childCode = [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => input += chunk);",
    "process.stdin.on('end', () => {",
    "  const message = JSON.parse(input);",
    "  const leaked = input.includes('private-secret') || Object.hasOwn(message, 'private');",
    "  process.stdout.write(JSON.stringify({ type: 'plan', plan: { decision: leaked ? 'REJECT' : 'USE', trace: { seen: message.public.visible } } }) + '\\n');",
    "});"
  ].join("\n");
  const result = await coordinate({
    command: process.execPath,
    args: ["-e", childCode],
    publicPayload: { visible: "public-value" },
    privatePayload: { expectedDecision: "USE", secret: "private-secret" },
    oracle: ({ privatePayload, candidate }) => ({ privateDecision: privatePayload.expectedDecision, candidateDecision: candidate.plan.decision })
  });

  assert.equal(result.candidate.plan.decision, "USE");
  assert.equal(result.candidate.plan.trace.seen, "public-value");
  assert.deepEqual(result.oracle, { privateDecision: "USE", candidateDecision: "USE" });
  assert.equal(result.candidate.publicPayload.secret, undefined);
  assert.deepEqual(DECISIONS, ["USE", "VALIDATE", "REJECT", "ACTION"]);
  assert.equal(ISOLATION_PROTOCOL, "premise-efficiency-lab/isolation/v1");
});

test("candidate process failures remain failures", async () => {
  await assert.rejects(
    () => runCandidate({
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
      publicPayload: { visible: true },
      timeoutMs: 2_000
    }),
    (error) => error?.code === "NONZERO_EXIT"
  );
});
