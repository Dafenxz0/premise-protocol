import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SourceReference, ValidationResult, VersionReference } from "@premise/protocol-types";

export interface FilesystemVersion extends VersionReference {
  readonly scheme: "filesystem.sha256";
}

export class FilesystemValidator {
  readonly id = "filesystem";

  async versionFor(sourceUri: string): Promise<FilesystemVersion> {
    const bytes = await readFile(this.toPath(sourceUri));
    const digest = createHash("sha256").update(bytes).digest("hex");
    return { scheme: "filesystem.sha256", token: digest };
  }

  async validate(source: SourceReference & { readonly memoryId?: string }): Promise<ValidationResult> {
    const memoryId = source.memoryId ?? source.sourceUri;
    try {
      const version = await this.versionFor(source.sourceUri);
      const result = source.version?.token === version.token && source.version.scheme === version.scheme ? "UNCHANGED" : source.version ? "CHANGED" : "UNCHANGED";
      return { memoryId, result, checkedAt: new Date().toISOString(), sourceUri: source.sourceUri, version };
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (message.includes("enoent") || message.includes("not found")) return { memoryId, result: "MISSING", checkedAt: new Date().toISOString(), sourceUri: source.sourceUri };
      return { memoryId, result: "UNKNOWN", checkedAt: new Date().toISOString(), sourceUri: source.sourceUri };
    }
  }

  private toPath(sourceUri: string): string {
    return sourceUri.startsWith("file:") ? fileURLToPath(sourceUri) : sourceUri;
  }
}
