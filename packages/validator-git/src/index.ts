import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SourceReference, ValidationResult, VersionReference } from "@premise/protocol-types";

export type GitVersionScheme = "git.commit" | "git.blob" | "git.tree";

export interface GitVersion extends VersionReference {
  readonly scheme: GitVersionScheme;
}

export interface ParsedGitSource {
  readonly repositoryPath: string;
  readonly objectPath?: string;
}

export class GitValidator {
  readonly id = "git";

  parse(sourceUri: string): ParsedGitSource {
    if (!sourceUri.startsWith("git+file:")) throw new Error("Git validator only accepts git+file:// source URIs");
    const fileUri = sourceUri.replace(/^git\+file:/, "file:");
    const separator = fileUri.indexOf("#");
    const repositoryUri = separator >= 0 ? fileUri.slice(0, separator) : fileUri;
    const objectPath = separator >= 0 ? decodeURIComponent(fileUri.slice(separator + 1)) : undefined;
    return { repositoryPath: fileURLToPath(repositoryUri), ...(objectPath ? { objectPath } : {}) };
  }

  versionFor(sourceUri: string): GitVersion {
    const source = this.parse(sourceUri);
    const head = this.git(source.repositoryPath, ["rev-parse", "HEAD"]);
    if (!source.objectPath) return { scheme: "git.commit", token: head };
    const object = this.git(source.repositoryPath, ["rev-parse", `HEAD:${source.objectPath}`]);
    const objectType = this.git(source.repositoryPath, ["cat-file", "-t", object]);
    return { scheme: objectType === "tree" ? "git.tree" : "git.blob", token: object };
  }

  async validate(source: SourceReference & { readonly memoryId?: string }): Promise<ValidationResult> {
    const memoryId = source.memoryId ?? source.sourceUri;
    try {
      const version = this.versionFor(source.sourceUri);
      const result = source.version?.scheme === version.scheme && source.version.token === version.token ? "UNCHANGED" : source.version ? "CHANGED" : "UNCHANGED";
      return { memoryId, result, status: result === "UNCHANGED" ? "FRESH" : "INVALID", checkedAt: new Date().toISOString(), sourceUri: source.sourceUri, version };
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as { readonly code?: unknown }).code) : "";
      if (code === "ENOENT" || code === "ENOTDIR" || message.includes("bad object") || message.includes("ambiguous argument") || message.includes("does not exist") || message.includes("not a git repository") || message.includes("no such file or directory")) return { memoryId, result: "MISSING", status: "INVALID", checkedAt: new Date().toISOString(), sourceUri: source.sourceUri };
      return { memoryId, result: "UNKNOWN", status: "UNKNOWN", checkedAt: new Date().toISOString(), sourceUri: source.sourceUri };
    }
  }

  private git(repositoryPath: string, args: readonly string[]): string {
    return execFileSync("git", ["-C", repositoryPath, ...args], { cwd: repositoryPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }
}
