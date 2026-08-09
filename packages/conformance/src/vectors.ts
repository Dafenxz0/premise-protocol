export interface VectorManifestEntry {
  readonly path: string;
  readonly vectorIds: readonly string[];
  readonly covers?: readonly string[];
}

export interface VectorManifest {
  readonly format: "premise-test-vector-manifest/0.1";
  readonly protocol: "premise/0.1";
  readonly files: readonly VectorManifestEntry[];
}

export interface VectorSuite {
  readonly format: "premise-test-vector-suite/0.1";
  readonly protocol: "premise/0.1";
  readonly suiteId: string;
  readonly vectors: readonly { vectorId: string; steps: readonly unknown[] }[];
}

export interface VectorValidationReport {
  readonly valid: boolean;
  readonly suiteCount: number;
  readonly vectorCount: number;
  readonly errors: readonly string[];
}

export function validateTestVectors(manifest: VectorManifest, suites: Readonly<Record<string, VectorSuite>>): VectorValidationReport {
  const errors: string[] = [];
  const seen = new Set<string>();
  let vectorCount = 0;
  for (const entry of manifest.files ?? []) {
    const suite = suites[entry.path];
    if (!suite) { errors.push(`${entry.path}: suite is missing`); continue; }
    const actual = (suite.vectors ?? []).map((vector) => vector.vectorId);
    if (actual.length === 0) errors.push(`${entry.path}: contains no vectors`);
    for (const id of actual) {
      if (seen.has(id)) errors.push(`${entry.path}: duplicate vector id ${id}`);
      seen.add(id);
      vectorCount += 1;
    }
    const expected = [...(entry.vectorIds ?? [])].sort();
    const actualSorted = [...actual].sort();
    if (JSON.stringify(expected) !== JSON.stringify(actualSorted)) errors.push(`${entry.path}: manifest vectorIds do not match suite vectors`);
    for (const vector of suite.vectors ?? []) if (!Array.isArray(vector.steps) || vector.steps.length === 0) errors.push(`${entry.path}/${vector.vectorId}: requires executable steps`);
  }
  return { valid: errors.length === 0, suiteCount: manifest.files?.length ?? 0, vectorCount, errors };
}
