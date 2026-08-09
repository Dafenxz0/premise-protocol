import type { World, WorldObservation } from "../engine/index.js";

class MutableWorld implements World {
  private readonly values = new Map<string, WorldObservation>();
  constructor(readonly kind: World["kind"], entries: readonly { sourceUri: string; content: unknown }[]) {
    for (const entry of entries) this.values.set(entry.sourceUri, { sourceUri: entry.sourceUri, version: { scheme: `${kind}.epoch`, token: "1" }, content: entry.content });
  }
  async read(sourceUri: string): Promise<WorldObservation> {
    const value = this.values.get(sourceUri);
    if (!value) throw new Error(`World resource missing: ${sourceUri}`);
    return clone(value);
  }
  async mutate(sourceUri: string, content: unknown): Promise<WorldObservation> {
    const previous = this.values.get(sourceUri);
    if (!previous) throw new Error(`World resource missing: ${sourceUri}`);
    const next = { sourceUri, version: { scheme: previous.version.scheme, token: String(Number(previous.version.token) + 1) }, content };
    this.values.set(sourceUri, next);
    return clone(next);
  }
  snapshot(): Readonly<Record<string, WorldObservation>> {
    return Object.fromEntries([...this.values.keys()].sort().map((key) => [key, clone(this.values.get(key)!)]));
  }
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

export function createEnvironment(kind: World["kind"], sourceUri = `${kind}://resource`): World { return new MutableWorld(kind, [{ sourceUri, content: { version: "initial" } }]); }
export function createFilesystemWorld(sourceUri?: string): World { return createEnvironment("filesystem", sourceUri); }
export function createGitWorld(sourceUri?: string): World { return createEnvironment("git", sourceUri); }
export function createGithubLikeWorld(sourceUri?: string): World { return createEnvironment("github-like", sourceUri); }
export function createStaticWorld(sourceUri?: string): World { return createEnvironment("static", sourceUri); }
