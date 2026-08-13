import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BASELINE_MANIFEST_FILE = new URL("./baseline-manifest.json", import.meta.url);

function command(commandName, args, cwd) {
  const executable = process.platform === "win32" && commandName === "pnpm" ? "pnpm.cmd" : commandName;
  if (process.platform === "win32" && executable.endsWith(".cmd")) {
    const quote = (value) => /^[A-Za-z0-9_./\\:@%+=,-]+$/u.test(value) ? value : `"${value.replaceAll('"', '""')}"`;
    const commandLine = [executable, ...args].map((value) => quote(String(value))).join(" ");
    return execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", commandLine], { cwd, encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"] }).trim();
  }
  return execFileSync(executable, args, { cwd, encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function filesUnder(root, relativeRoot) {
  const output = [];
  const absoluteRoot = join(root, relativeRoot);
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else output.push(absolute);
    }
  }
  if (await exists(absoluteRoot)) await walk(absoluteRoot);
  return output;
}

export async function artifactDigest(root, { relativeRoots = ["packages/runtime-core/dist", "packages/protocol-types/dist"], exclusions = ["**/tsconfig.tsbuildinfo"] } = {}) {
  const excluded = (name) => exclusions.some((pattern) => pattern === "**/tsconfig.tsbuildinfo" && name.endsWith("/tsconfig.tsbuildinfo"));
  const files = (await Promise.all(relativeRoots.map((item) => filesUnder(root, item))))
    .flat()
    .filter((file) => !excluded(relative(root, file).replaceAll("\\", "/")))
    .sort((left, right) => {
      const leftName = relative(root, left).replaceAll("\\", "/");
      const rightName = relative(root, right).replaceAll("\\", "/");
      return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
    });
  const hash = createHash("sha256");
  const fileManifest = [];
  for (const file of files) {
    const name = relative(root, file).replaceAll("\\", "/");
    const bytes = await readFile(file);
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    hash.update(`${name}\0${bytes.byteLength}\0${fileHash}\n`);
    fileManifest.push(Object.freeze({ path: name, bytes: bytes.byteLength, sha256: `sha256:${fileHash}` }));
  }
  return { digest: `sha256:${hash.digest("hex")}`, files: files.length, fileManifest: Object.freeze(fileManifest) };
}

async function readManifest() {
  return JSON.parse(await readFile(BASELINE_MANIFEST_FILE, "utf8"));
}

function verifyNode(manifest) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major !== 24) throw new Error(`BASELINE_NODE_VERSION_MISMATCH:${process.versions.node}`);
  if (manifest.nodeVersion !== "24") throw new Error(`BASELINE_MANIFEST_NODE_MISMATCH:${manifest.nodeVersion}`);
}

function verifyToolchain(root, manifest) {
  const pnpmVersion = command("pnpm", ["--version"], root);
  if (manifest.pnpmVersion !== undefined && pnpmVersion !== manifest.pnpmVersion) throw new Error(`BASELINE_PNPM_VERSION_MISMATCH:${pnpmVersion}`);
  const typescriptVersion = command("pnpm", ["exec", "tsc", "--version"], root);
  if (manifest.typescriptVersion !== undefined && typescriptVersion !== `Version ${manifest.typescriptVersion}`) throw new Error(`BASELINE_TYPESCRIPT_VERSION_MISMATCH:${typescriptVersion}`);
}

export async function prepareBaselineArtifact({ root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../"), fetchMissing = true } = {}) {
  const manifest = await readManifest();
  verifyNode(manifest);
  let commit;
  try {
    commit = command("git", ["rev-parse", `${manifest.commit}^{commit}`], root);
  } catch (error) {
    if (!fetchMissing) throw error;
    command("git", ["fetch", "--no-tags", "origin", manifest.commit, "--depth=1"], root);
    commit = command("git", ["rev-parse", `${manifest.commit}^{commit}`], root);
  }
  if (commit !== manifest.commit) throw new Error(`BASELINE_COMMIT_MISMATCH:${commit}`);
  const worktree = resolve(root, ".tmp", "premise-efficiency-lab", "v1", "frontier", "baseline", manifest.commit.slice(0, 12));
  if (!(await exists(join(worktree, ".git")))) {
    await mkdir(dirname(worktree), { recursive: true });
    command("git", ["worktree", "add", "--detach", worktree, manifest.commit], root);
  } else {
    const actual = command("git", ["rev-parse", "HEAD"], worktree);
    if (actual !== manifest.commit) throw new Error(`BASELINE_WORKTREE_MISMATCH:${actual}`);
  }
  if (command("git", ["status", "--porcelain=v1", "--untracked-files=all"], worktree) !== "") throw new Error("BASELINE_WORKTREE_DIRTY");
  if (!(await exists(join(worktree, "node_modules")))) {
    command("pnpm", ["install", "--offline", "--frozen-lockfile"], worktree);
  }
  verifyToolchain(worktree, manifest);
  if (!(await exists(join(worktree, "packages", "runtime-core", "dist", "index.js")))) command("pnpm", ["build"], worktree);
  const artifact = await artifactDigest(worktree, { relativeRoots: manifest.artifactPaths, exclusions: manifest.artifactExclude });
  if (artifact.digest !== manifest.artifactDigest) throw new Error(`BASELINE_ARTIFACT_DIGEST_MISMATCH:${artifact.digest}`);
  if (artifact.files !== manifest.artifactFileCount) throw new Error(`BASELINE_ARTIFACT_FILE_COUNT_MISMATCH:${artifact.files}`);
  return Object.freeze({
    manifest,
    commit,
    artifactDigest: artifact.digest,
    artifactFiles: artifact.files,
    artifactFileManifest: artifact.fileManifest,
    worktree,
    runtimeEntry: join(worktree, "packages", "runtime-core", "dist", "index.js"),
    artifactVerified: true
  });
}

export async function loadBaselineEngine(options = {}) {
  const artifact = await prepareBaselineArtifact(options);
  const module = await import(pathToFileURL(artifact.runtimeEntry).href);
  if (typeof module.IncrementalFrontierEngine !== "function") throw new Error("BASELINE_ENGINE_EXPORT_MISSING");
  return Object.freeze({ ...artifact, Engine: module.IncrementalFrontierEngine });
}
