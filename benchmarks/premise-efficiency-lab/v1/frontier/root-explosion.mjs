import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { artifactDigest } from "./baseline-artifact.mjs";

export const ROOT_EXPLOSION_FORMAT = "premise-efficiency-lab/frontier-root-explosion/v1";
const CASE_FILE = fileURLToPath(new URL("./root-explosion-case.mjs", import.meta.url));

const PROFILES = Object.freeze({
  smoke: Object.freeze({ roots: Object.freeze([16, 32, 64, 128]), orders: Object.freeze(["forward"]), timeoutMs: 30_000 }),
  medium: Object.freeze({ roots: Object.freeze([100, 500, 1_000]), orders: Object.freeze(["forward", "reverse"]), timeoutMs: 30_000 }),
  full: Object.freeze({ roots: Object.freeze([100, 1_000, 10_000, 50_000]), orders: Object.freeze(["forward", "reverse", "interleaved"]), timeoutMs: 60_000 })
});
const TOPOLOGIES = Object.freeze(["nested-diamond", "meshed", "reconvergent", "wide"]);

function parseArgs(argv) {
  return new Map(argv.map((item) => {
    const [key, value = "true"] = item.replace(/^--/u, "").split("=", 2);
    return [key, value];
  }));
}

export function rootExplosionPlan(profileName = "smoke") {
  const profile = PROFILES[profileName];
  if (profile === undefined) throw new RangeError(`Unknown root-explosion profile: ${profileName}`);
  return Object.freeze(profile.roots.flatMap((roots) => profile.orders.flatMap((order) => TOPOLOGIES.map((topology) => Object.freeze({
    topology,
    roots,
    order,
    timeoutMs: roots >= 10_000 ? Math.min(profile.timeoutMs, 10_000) : profile.timeoutMs
  })))));
}

function compactError(status, error, stderr = "") {
  return Object.freeze({ status, error: String(error), stderr: stderr.trim().slice(-2_000) });
}

function resourceFailure(code, signal, stderr) {
  return signal === "SIGKILL"
    || signal === "SIGTERM"
    || /out of memory|heap limit|ENOMEM|fatal process out of memory/iu.test(stderr)
    || signal === "SIGXCPU";
}

function terminateWorker(child) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGKILL");
  }
}

async function candidateProvenance() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: resolve("."), encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: resolve("."), encoding: "utf8" }).trim();
  if (status !== "") throw new Error("CANDIDATE_WORKTREE_DIRTY");
  const artifact = await artifactDigest(resolve("."));
  return Object.freeze({ commit, artifactDigest: artifact.digest, artifactFiles: artifact.files });
}

function runCase({ topology, roots, order, implementation, seed, timeoutMs, provenance }) {
  return new Promise((resolveCase) => {
    const child = spawn(process.execPath, ["--stack-size=65500", CASE_FILE, `--topology=${topology}`, `--roots=${roots}`, `--order=${order}`, `--implementation=${implementation}`, `--seed=${seed}`], {
    cwd: resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PREMiSE_CANDIDATE_COMMIT: provenance.commit,
        PREMiSE_CANDIDATE_ARTIFACT_DIGEST: provenance.artifactDigest
      }
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timedOut = false;
    let teardownTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (teardownTimer !== undefined) clearTimeout(teardownTimer);
      resolveCase(Object.freeze(value));
    };
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", (error) => finish(compactError("ERROR", error, stderr.join(""))));
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish(compactError("TIMEOUT", `${implementation} ${topology} order=${order} roots=${roots} exceeded ${timeoutMs}ms`, stderr.join("")));
        return;
      }
      const lines = stdout.join("").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
      const last = lines.at(-1);
      if (code !== 0) {
        finish(compactError(resourceFailure(code, signal, stderr.join("")) ? "INCONCLUSIVE" : "ERROR", `exit=${code ?? "null"}${signal ? ` signal=${signal}` : ""}`, stderr.join("")));
        return;
      }
      try {
        const parsed = JSON.parse(last);
        if (parsed.topology !== topology || parsed.rootCount !== roots || parsed.rootOrder !== order || parsed.implementation !== implementation) {
          finish(compactError("ERROR", "worker fixture identity mismatch", JSON.stringify({ expected: { topology, roots, order, implementation }, actual: parsed })));
          return;
        }
        finish(parsed);
      } catch (error) {
        finish(compactError("ERROR", `invalid worker JSON: ${error.message}`, `${stderr.join("")}\n${stdout.join("")}`));
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminateWorker(child);
      // A timeout is not a teardown barrier. Wait until the child process has
      // actually closed before the next case starts, otherwise two workers
      // can overlap and contaminate CPU/RSS measurements.
      teardownTimer = setTimeout(() => {
        finish(compactError("TIMEOUT", `${implementation} ${topology} order=${order} roots=${roots} exceeded ${timeoutMs}ms; teardown deadline elapsed`, stderr.join("")));
      }, 5_000);
    }, timeoutMs);
  });
}

function sameBehavior(candidate, champion) {
  return candidate.status === "PASS"
    && champion.status === "PASS"
    && candidate.decision?.complete === true
    && champion.decision?.complete === true
    && candidate.affectedCount === champion.affectedCount
    && candidate.affectedDigest === champion.affectedDigest
    && candidate.frontierCount === champion.frontierCount
    && candidate.frontierDigest === champion.frontierDigest
    && candidate.decision?.status === champion.decision?.status
    && candidate.decision?.complete === champion.decision?.complete;
}

export function compareResults(candidate, champion) {
  if (candidate.status === "TIMEOUT") return Object.freeze({ status: "INCONCLUSIVE", reason: "candidate timed out", equivalent: null });
  if (candidate.status === "INCONCLUSIVE") return Object.freeze({ status: "INCONCLUSIVE", reason: candidate.reason ?? "candidate incomplete", equivalent: null });
  if (candidate.status !== "PASS") return Object.freeze({ status: "FAIL", reason: "candidate did not complete", equivalent: false });
  if (candidate.accountingReconciled !== true || candidate.reachabilityCacheAccountingReconciled !== true) return Object.freeze({ status: "FAIL", reason: "candidate physical accounting did not reconcile", equivalent: false });
  if (candidate.counterContract?.complete !== true || candidate.counterContract?.normalized !== true) return Object.freeze({ status: "FAIL", reason: "candidate counter contract is incomplete", equivalent: false });
  if (champion.status === "TIMEOUT") return Object.freeze({ status: "INCONCLUSIVE", reason: "champion timed out", equivalent: null });
  if (champion.status !== "PASS") return Object.freeze({ status: "INCONCLUSIVE", reason: "champion did not complete", equivalent: null });
  if (champion.accountingReconciled !== true || champion.reachabilityCacheAccountingReconciled !== true) return Object.freeze({ status: "INCONCLUSIVE", reason: "champion physical accounting did not reconcile", equivalent: null });
  if (champion.counterContract?.normalized !== true || (champion.counterContract?.complete !== true && champion.counterContract?.knownBaselineNoCache !== true)) return Object.freeze({ status: "INCONCLUSIVE", reason: "champion counter contract is incomplete", equivalent: null });
  const equivalent = sameBehavior(candidate, champion);
  const physicalReduction = equivalent && champion.physicalWork > 0
    ? (champion.physicalWork - candidate.physicalWork) / champion.physicalWork
    : null;
  return Object.freeze({
    status: equivalent ? "PASS" : "FAIL",
    reason: equivalent ? "exact behavior match" : "behavior mismatch",
    equivalent,
    physicalReduction
  });
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function markdown(result) {
  const lines = [
    "# PR25 root-explosion benchmark",
    "",
    `- Status: **${result.status}**`,
    `- Profile: \`${result.profile}\``,
    `- Seed: \`${result.seed}\``,
    `- Cases: ${result.cases.length}`,
    `- Median physical reduction: ${result.summary.medianPhysicalReduction ?? "n/a"}`,
    `- Optimization gate: **${result.summary.optimizationGate}**`,
    "",
    "This report compares the PR25 candidate with the frozen PR24 champion. A champion timeout is reported as INCONCLUSIVE; it is never treated as a candidate win.",
    "",
    "| Topology | Order | Roots | Candidate ms | Champion ms | Candidate work | Champion work | Comparison |",
    "|---|---|---:|---:|---:|---:|---:|---|"
  ];
  for (const row of result.cases) {
    const candidate = row.candidate;
    const champion = row.champion;
    lines.push(`| ${row.topology} | ${row.order} | ${row.roots} | ${candidate.elapsedMs ?? "—"} | ${champion.elapsedMs ?? champion.status} | ${candidate.physicalWork ?? "—"} | ${champion.physicalWork ?? "—"} | ${row.comparison.status} |`);
  }
  lines.push("", "## Claims", "", "- Exact candidate/champion behavior is required for every comparable case.", "- Physical reduction is reported only for equivalent cases where both implementations finish.", "- No commercial, safety, or universal-scale claim is made by this benchmark.", "");
  return `${lines.join("\n")}\n`;
}

export function optimizationGate({ totalCases, comparableCases, inconclusiveCases, medianPhysicalReduction }) {
  if (totalCases === 0 || inconclusiveCases > 0 || comparableCases !== totalCases) return "INCONCLUSIVE";
  return medianPhysicalReduction !== null && medianPhysicalReduction > 0 ? "PASS" : "FAIL";
}

export async function runRootExplosion({ profile = "smoke", seed = 20260813, output = ".tmp/premise-efficiency-lab/v1/frontier/root-explosion" } = {}) {
  const provenance = await candidateProvenance();
  const cases = [];
  for (const planned of rootExplosionPlan(profile)) {
    // Large/diagnostic runs are candidate-first so a bounded candidate can
    // fail closed before spending minutes reconstructing an obsolete champion.
    // Medium and smoke alternate order to reduce timing-order bias.
    const candidateFirst = profile === "full" ? true : cases.length % 2 === 0;
    const firstImplementation = candidateFirst ? "candidate" : "champion";
    const secondImplementation = candidateFirst ? "champion" : "candidate";
    const first = await runCase({ ...planned, implementation: firstImplementation, seed, provenance });
    const candidateIncomplete = firstImplementation === "candidate"
      && (first.status !== "PASS" || first.decision?.complete !== true || first.accountingReconciled !== true);
    const diagnosticScale = profile === "full" && planned.roots >= 10_000;
    const second = candidateIncomplete || diagnosticScale
      ? Object.freeze({ status: "NOT_RUN", reason: candidateIncomplete ? "candidate incomplete; champion comparison unavailable" : "diagnostic scale is candidate-only unless separately budgeted" })
      : await runCase({ ...planned, implementation: secondImplementation, seed, provenance });
    const candidate = candidateFirst ? first : second;
    const champion = candidateFirst ? second : first;
    const comparison = compareResults(candidate, champion);
    const referenceEquivalent = candidate.referenceEquivalent;
    cases.push(Object.freeze({
      topology: planned.topology,
      order: planned.order,
      executionOrder: Object.freeze([firstImplementation, secondImplementation]),
      roots: planned.roots,
      seed,
      candidate,
      champion,
      comparison,
      referenceEquivalent: referenceEquivalent === undefined ? null : referenceEquivalent
    }));
  }
  const candidateFailures = cases.filter(({ candidate }) => candidate.status === "ERROR");
  const candidateTimeouts = cases.filter(({ candidate }) => candidate.status === "TIMEOUT");
  const candidateInconclusive = cases.filter(({ candidate }) => candidate.status === "INCONCLUSIVE");
  const accountingFailures = cases.filter(({ candidate }) => candidate.status === "PASS" && candidate.accountingReconciled !== true);
  const referenceFailures = cases.filter(({ referenceEquivalent }) => referenceEquivalent === false);
  const comparisonFailures = cases.filter(({ comparison }) => comparison.status === "FAIL");
  const inconclusive = cases.filter(({ comparison }) => comparison.status === "INCONCLUSIVE");
  const candidateTimes = cases.map(({ candidate }) => candidate.elapsedMs);
  const candidateWork = cases.map(({ candidate }) => candidate.physicalWork);
  const medianPhysicalReduction = median(cases.map(({ comparison }) => comparison.physicalReduction));
  const comparableCases = cases.filter(({ comparison }) => comparison.equivalent === true).length;
  const optimizationStatus = optimizationGate({
    totalCases: cases.length,
    comparableCases,
    inconclusiveCases: inconclusive.length,
    medianPhysicalReduction
  });
  const status = candidateFailures.length > 0 || accountingFailures.length > 0 || referenceFailures.length > 0 || comparisonFailures.length > 0
    ? "FAIL"
    : candidateTimeouts.length > 0 || candidateInconclusive.length > 0 || inconclusive.length > 0 ? "INCONCLUSIVE"
      : optimizationStatus === "PASS" ? "PASS" : "FAIL";
  const result = Object.freeze({
    format: ROOT_EXPLOSION_FORMAT,
    status,
    profile,
    candidate: provenance,
    seed,
    cases: Object.freeze(cases),
    summary: Object.freeze({
      totalCases: cases.length,
      candidateFailures: candidateFailures.length,
      candidateTimeouts: candidateTimeouts.length,
      candidateInconclusive: candidateInconclusive.length,
      accountingFailures: accountingFailures.length,
      referenceFailures: referenceFailures.length,
      comparisonFailures: comparisonFailures.length,
      inconclusive: inconclusive.length,
      candidateMedianMs: median(candidateTimes),
      candidateMedianPhysicalWork: median(candidateWork),
      comparableCases,
      medianPhysicalReduction,
      optimizationGate: optimizationStatus
    }),
    claims: Object.freeze({
      exactCandidateReferenceForSmallCases: cases.some(({ roots }) => roots <= 128)
        && cases.filter(({ roots }) => roots <= 128).every(({ referenceEquivalent }) => referenceEquivalent === true),
      exactCandidateChampionForComparableCases: comparisonFailures.length === 0 && inconclusive.length === 0 && cases.length > 0,
      candidateAccountingReconciled: cases.every(({ candidate }) => candidate.status === "PASS" && candidate.accountingReconciled === true),
      physicalReductionClaim: false,
      safetyClaim: false,
      commercialClaim: false
    })
  });
  const outputRoot = resolve(output);
  await mkdir(outputRoot, { recursive: true });
  await writeFile(resolve(outputRoot, `${profile}.json`), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(resolve(outputRoot, `${profile}.md`), markdown(result));
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profile = args.get("profile") ?? "smoke";
  const result = await runRootExplosion({
    profile,
    seed: Number(args.get("seed") ?? 20260813),
    output: args.get("output") ?? ".tmp/premise-efficiency-lab/v1/frontier/root-explosion"
  });
  process.stdout.write(`${JSON.stringify({ status: result.status, profile, cases: result.cases.length, summary: result.summary })}\n`);
  if (result.status !== "PASS") process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
