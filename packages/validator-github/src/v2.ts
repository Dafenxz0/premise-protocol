import type { EvidenceReference, VersionReference, V2MemoryStatus } from "@premise/protocol-types";
import { GitHubValidator, type GitHubRequestOptions } from "./index.js";

export interface GitHubV2ValidationReport {
  readonly memoryId: string;
  readonly evidenceId: string;
  readonly result: "UNCHANGED" | "CHANGED" | "MISSING" | "UNKNOWN";
  readonly status: V2MemoryStatus;
  readonly checkedAt: string;
  readonly sourceUri: string;
  readonly version?: VersionReference;
  readonly reason?: string;
}

export interface GitHubRepositorySnapshot {
  readonly repository: unknown;
  readonly commits: readonly unknown[];
  readonly branches: readonly unknown[];
  readonly issues: readonly unknown[];
  readonly pullRequests: readonly unknown[];
  readonly releases: readonly unknown[];
  readonly observedAt: string;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && (/404|not found|unknown source/i.test(error.message));
}

export class GitHubV2Adapter {
  readonly id = "github-v2";

  constructor(readonly github: GitHubValidator) {}

  async versionFor(sourceUri: string, options: GitHubRequestOptions = {}): Promise<VersionReference> {
    return this.github.versionFor(sourceUri, options);
  }

  async validate(evidence: EvidenceReference & { readonly memoryId?: string }, options: GitHubRequestOptions = {}): Promise<GitHubV2ValidationReport> {
    const memoryId = evidence.memoryId ?? evidence.evidenceId;
    try {
      const version = await this.versionFor(evidence.sourceUri, options);
      const unchanged = evidence.version?.scheme === version.scheme && evidence.version.token === version.token;
      return {
        memoryId,
        evidenceId: evidence.evidenceId,
        result: evidence.version === undefined || unchanged ? "UNCHANGED" : "CHANGED",
        status: evidence.version === undefined || unchanged ? "FRESH" : "INVALID",
        checkedAt: new Date().toISOString(),
        sourceUri: evidence.sourceUri,
        version
      };
    } catch (error) {
      const missing = isMissing(error);
      return { memoryId, evidenceId: evidence.evidenceId, result: missing ? "MISSING" : "UNKNOWN", status: missing ? "INVALID" : "UNKNOWN", checkedAt: new Date().toISOString(), sourceUri: evidence.sourceUri, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async snapshot(owner: string, repo: string, options: GitHubRequestOptions = {}): Promise<GitHubRepositorySnapshot> {
    const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const [repository, commits, branches, issues, pullRequests, releases] = await Promise.all([
      this.github.get(root, options),
      this.github.get(`${root}/commits?per_page=100`, options),
      this.github.get(`${root}/branches?per_page=100`, options),
      this.github.get(`${root}/issues?state=all&per_page=100`, options),
      this.github.get(`${root}/pulls?state=all&per_page=100`, options),
      this.github.get(`${root}/releases?per_page=100`, options)
    ]);
    return {
      repository,
      commits: Array.isArray(commits) ? commits : [],
      branches: Array.isArray(branches) ? branches : [],
      issues: Array.isArray(issues) ? issues : [],
      pullRequests: Array.isArray(pullRequests) ? pullRequests : [],
      releases: Array.isArray(releases) ? releases : [],
      observedAt: new Date().toISOString()
    };
  }
}
