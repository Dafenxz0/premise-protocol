import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const benchmarksDir = path.dirname(fileURLToPath(import.meta.url));
const sources = {
  realWorld: path.join(benchmarksDir, "real-world-bench", "results.json"),
  contextCorpus: path.join(benchmarksDir, "context-corpus-bench", "results.json")
};
const output = path.join(benchmarksDir, "benchmark-report.md");

const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const integerFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const percentFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function assertInput(condition, message) {
  if (!condition) throw new Error(`Artefacto de benchmark inválido: ${message}`);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`No se pudo leer ${path.relative(process.cwd(), file)}: ${error.message}`, { cause: error });
  }
}

function validateInputs(realWorld, contextCorpus) {
  assertInput(realWorld?.format, "falta format en real-world-bench/results.json");
  assertInput(Array.isArray(realWorld.scenarios), "falta scenarios en real-world-bench/results.json");
  assertInput(Array.isArray(realWorld.pairedMetrics), "falta pairedMetrics en real-world-bench/results.json");
  assertInput(realWorld.scenarioCount === realWorld.scenarios.length, "scenarioCount no coincide con scenarios");
  assertInput(contextCorpus?.format, "falta format en context-corpus-bench/results.json");
  assertInput(Array.isArray(contextCorpus.setups), "falta setups en context-corpus-bench/results.json");
  assertInput(Array.isArray(contextCorpus.results), "falta results en context-corpus-bench/results.json");
  assertInput(contextCorpus.results.length > 0, "results está vacío en context-corpus-bench/results.json");
}

function unique(values) {
  return [...new Set(values)];
}

function groupBy(items, selector) {
  return items.reduce((groups, item) => {
    const key = selector(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
    return groups;
  }, new Map());
}

function formatNumber(value, digits = 3) {
  return Number.isFinite(Number(value)) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(Number(value)) : "—";
}

function formatInteger(value) {
  return Number.isFinite(Number(value)) ? integerFormatter.format(Number(value)) : "—";
}

function formatPercent(value) {
  return Number.isFinite(Number(value)) ? `${percentFormatter.format(Number(value) * 100)}%` : "—";
}

function formatMs(value) {
  return Number.isFinite(Number(value)) ? `${numberFormatter.format(Number(value))} ms` : "—";
}

function formatMb(bytes, signed = false) {
  if (!Number.isFinite(Number(bytes))) return "—";
  const value = Number(bytes) / (1024 ** 2);
  const sign = signed && value > 0 ? "+" : signed && value < 0 ? "−" : "";
  return `${sign}${formatNumber(Math.abs(value), 2)} MB`;
}

function escapeCell(value) {
  return String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function markdownTable(headers, rows, numericColumns = []) {
  const numeric = new Set(numericColumns);
  const separator = headers.map((_, index) => numeric.has(index) ? "---:" : ":---");
  return [
    `| ${headers.map(escapeCell).join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`)
  ].join("\n");
}

function statusIcon(kind, rate) {
  if (!Number.isFinite(Number(rate))) return "ℹ️";
  if (kind === "zero") return Number(rate) === 0 ? "✅" : "❌";
  if (Number(rate) === 1) return "✅";
  if (Number(rate) > 0) return "⚠️";
  return "❌";
}

function rateCell(rate, numerator, denominator, kind = "one") {
  if (!Number.isFinite(Number(rate)) || !Number(denominator)) return "ℹ️ no medido";
  return `${statusIcon(kind, rate)} ${formatPercent(rate)} (${formatInteger(numerator)}/${formatInteger(denominator)})`;
}

function latencyCell(latency) {
  const p50 = latency?.p50Ms ?? latency?.p50;
  const p95 = latency?.p95Ms ?? latency?.p95;
  if (!Number.isFinite(Number(p50)) || !Number.isFinite(Number(p95))) return "ℹ️ no medido";
  return `p50 ${formatMs(p50)} / p95 ${formatMs(p95)}`;
}

function stateCell(state) {
  if (!state?.status && !state?.decision) return "—";
  const icon = state.status === "FRESH" ? "✅" : state.status === "STALE" ? "⚠️" : state.status === "INVALID" ? "❌" : "ℹ️";
  return `${icon} \`${state.status ?? "—"}\` / \`${state.decision ?? "—"}\``;
}

function strategyMetrics(realWorld, name) {
  const entry = realWorld.pairedMetrics.find((metric) => metric.strategy.toLowerCase() === name.toLowerCase());
  assertInput(entry, `no existe la estrategia ${name} en pairedMetrics`);
  return entry;
}

function strategyRow(metric) {
  const denominators = metric.denominators;
  return [
    metric.strategy,
    `${statusIcon("one", metric.security.correctDecisionRate)} ${formatPercent(metric.security.correctDecisionRate)} (${formatInteger(metric.security.correctDecisions)}/${formatInteger(metric.episodes)})`,
    rateCell(metric.security.unsafeActionRate, metric.security.unsafeActions, denominators.unsafeToUse, "zero"),
    rateCell(metric.security.falseRejectionRate, metric.security.falseRejections, denominators.safeToUse, "zero"),
    rateCell(metric.validation.resultMatchRate, metric.validation.resultMatches, denominators.validationCases),
    rateCell(metric.recovery.validatedRecoveryRate, metric.recovery.validatedRecoveries, denominators.recoveryCandidates),
    metric.isolation?.measured ? rateCell(metric.isolation.passRate, metric.isolation.passed, metric.isolation.cases) : "ℹ️ no medido",
    latencyCell(metric.latencyMs)
  ];
}

function realFixtureCoverage(realWorld) {
  const rows = [...groupBy(realWorld.scenarios, (scenario) => scenario.storage).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([storage, scenarios]) => [
      `✅ ${storage}`,
      `${formatInteger(scenarios.length)} / ${formatInteger(realWorld.scenarioCount)}`,
      unique(scenarios.map((scenario) => scenario.category)).join(", "),
      unique(scenarios.map((scenario) => scenario.mutation)).join(", "),
      unique(scenarios.map((scenario) => scenario.target)).join(", ")
    ]);

  return markdownTable(
    ["Fixture real", "Casos", "Categorías", "Mutaciones", "Targets"],
    rows,
    [1]
  );
}

function realWorldSection(realWorld) {
  const noProtocol = strategyMetrics(realWorld, "No protocol");
  const premise = strategyMetrics(realWorld, "PREMiSE");
  const rows = [noProtocol, premise].map(strategyRow);
  const validators = Object.entries(realWorld.integrations?.validators ?? {})
    .map(([name, implementation]) => `${name}: ${implementation}`)
    .join(" · ");

  return [
    "## Seguridad y efectividad en fixtures reales",
    "",
    `La suite **${realWorld.suite}** contiene **${formatInteger(realWorld.scenarioCount)} episodios emparejados**. Las tasas muestran el numerador y su denominador real; ` +
      "`No protocol` y `PREMiSE` son las dos estrategias registradas en `pairedMetrics`.",
    "",
    markdownTable(
      ["Estrategia", "Decisiones correctas", "Acciones inseguras", "Rechazos falsos", "Validación", "Recuperación validada", "Aislamiento", "Latencia decisión"],
      rows,
      [1, 2, 3, 4, 5, 6, 7]
    ),
    "",
    "### Cobertura de fixtures",
    "",
    realFixtureCoverage(realWorld),
    "",
    `Validadores declarados por el artefacto: ${validators || "ℹ️ no especificados"}.`,
    "",
    "Lectura de estados: ✅ correcto, ⚠️ parcial o estado transitorio, ❌ fallo de seguridad/efectividad, ℹ️ no medido."
  ].join("\n");
}

function patternLabel(pattern) {
  const labels = { chain: "chain · cadena", fanout: "fanout · abanico", shared: "shared · compartido" };
  return labels[pattern] ?? pattern;
}

function contextQualityRow(result) {
  const postSignal = result.queries.postSignal;
  const affectedRate = result.nodes ? result.propagation.affectedNodes / result.nodes : null;
  return [
    formatInteger(result.nodes),
    patternLabel(result.pattern),
    `${formatInteger(result.propagation.affectedNodes)} / ${formatInteger(result.nodes)} (${formatPercent(affectedRate)})`,
    `${statusIcon("one", result.metrics.precision)} ${formatPercent(result.metrics.precision)}`,
    `${statusIcon("one", result.metrics.retrievalHitRate)} ${formatPercent(result.metrics.retrievalHitRate)}`,
    `${statusIcon("one", postSignal.safety)} ${formatPercent(postSignal.safety)}`,
    `${statusIcon("zero", postSignal.falseRejectRate)} ${formatPercent(postSignal.falseRejectRate)}`,
    formatInteger(postSignal.blockedCandidates)
  ];
}

function contextCostRow(result) {
  const finalQuery = result.queries.final;
  return [
    formatInteger(result.nodes),
    patternLabel(result.pattern),
    latencyCell(result.metrics.latency.signal),
    latencyCell(result.metrics.latency.query),
    formatMb(result.metrics.metadata.serializedMetadataBytes),
    formatMb(result.metrics.heap.signedDeltaBytes, true),
    formatMs(result.timings.totalMs),
    formatInteger(finalQuery.queries)
  ];
}

function contextStateTimeline(contextCorpus) {
  const stages = ["before", "afterSignal", "afterValidation", "afterRepair"];
  const labels = {
    before: "Antes de señal",
    afterSignal: "Después de señal",
    afterValidation: "Después de validación",
    afterRepair: "Después de reparación"
  };
  const rows = stages.map((stage) => {
    const states = unique(contextCorpus.results.map((result) => `${result.checks[stage]?.status ?? "—"}/${result.checks[stage]?.decision ?? "—"}`));
    return [labels[stage], states.map((value) => stateCell({ status: value.split("/")[0], decision: value.split("/").slice(1).join("/") })).join("<br>")];
  });
  return markdownTable(["Fase observada", "Estado / decisión"], rows);
}

function setupSection(contextCorpus) {
  const rows = [...contextCorpus.setups]
    .sort((left, right) => left.nodes - right.nodes)
    .map((setup) => [
      formatInteger(setup.nodes),
      formatMs(setup.corpusGenerationMs),
      formatMs(setup.indexBuildMs),
      formatMb(setup.payloadBytes),
      formatMb(setup.indexMetadataBytes)
    ]);
  return markdownTable(
    ["Perfil (nodos)", "Generación corpus", "Construcción índice", "Payload externo", "Metadata índice"],
    rows,
    [0, 1, 2, 3, 4]
  );
}

function contextCorpusSection(contextCorpus) {
  const results = [...contextCorpus.results].sort((left, right) => left.nodes - right.nodes || left.pattern.localeCompare(right.pattern));
  const patterns = unique(results.map((result) => result.pattern));
  const profiles = unique(results.map((result) => result.nodes)).sort((left, right) => left - right);
  const largest = results.reduce((current, result) => result.nodes > current.nodes ? result : current, results[0]);
  const largestFinal = largest.metrics.retrievalHitRate;

  return [
    "## Escalado por tamaño y patrón",
    "",
    `El corpus registra **${formatInteger(profiles.length)} perfiles de tamaño** y **${formatInteger(patterns.length)} patrones** (${patterns.map(patternLabel).join(", ")}). Cada fila conserva el tamaño y patrón del resultado original; no se interpolan puntos ausentes.`,
    "",
    "### Calidad y seguridad",
    "",
    markdownTable(
      ["Nodos", "Patrón", "Propagación afectada", "Precisión", "Hit final", "Seguridad tras señal", "Falso rechazo tras señal", "Bloqueadas tras señal"],
      results.map(contextQualityRow),
      [0, 2, 3, 4, 5, 6, 7]
    ),
    "",
    "### Coste y latencia",
    "",
    markdownTable(
      ["Nodos", "Patrón", "Señal p50 / p95", "Consulta p50 / p95", "Metadata serializada", "Heap Δ firmado", "Tiempo total", "Consultas"],
      results.map(contextCostRow),
      [0, 2, 3, 4, 5, 6, 7]
    ),
    "",
    "`Señal` y `Consulta` son latencias p50/p95 del resultado; `Heap Δ firmado` conserva el signo del artefacto. MB se presenta en base 1024.",
    "",
    "### Coste de preparación por tamaño",
    "",
    setupSection(contextCorpus),
    "",
    `En el perfil máximo registrado (${formatInteger(largest.nodes)} nodos, patrón ${patternLabel(largest.pattern)}), el hit final observado es ${statusIcon("one", largestFinal)} ${formatPercent(largestFinal)}.`,
    "",
    "### Ciclo de estado observado",
    "",
    contextStateTimeline(contextCorpus),
    "",
    `El artefacto declara aislamiento ${contextCorpus.invariants?.isolation?.passed ? "✅ superado" : "❌ no superado"} y payload externo almacenado en el protocolo ${contextCorpus.corpus?.externalPayloadStoredInProtocol ? "❌ sí" : "✅ no"}.`
  ].join("\n");
}

function sourceSection(realWorld, contextCorpus) {
  const realDeterminism = realWorld.determinism ?? {};
  return [
    "## Fuentes y reproducibilidad",
    "",
    markdownTable(
      ["Artefacto", "Formato", "Runner", "Seed", "Determinismo / ejecución"],
      [
        [
          "`benchmarks/real-world-bench/results.json`",
          realWorld.format,
          realWorld.runner,
          realWorld.seed,
          `offline ${realDeterminism.networkAccess === false ? "✅" : "⚠️"}; orden estable ${realDeterminism.stableScenarioOrder ? "✅" : "⚠️"}`
        ],
        [
          "`benchmarks/context-corpus-bench/results.json`",
          contextCorpus.format,
          contextCorpus.runner,
          contextCorpus.seed,
          `offline ${contextCorpus.offline ? "✅" : "⚠️"}; determinista ${contextCorpus.deterministic ? "✅" : "⚠️"}`
        ]
      ]
    ),
    "",
    `El runtime reportado para fixtures reales es Node ${realWorld.runtime?.node ?? "—"} y Git ${realWorld.runtime?.git ?? "—"}. Tiempos fijos declarados: protocolo ${realDeterminism.fixedProtocolTime ?? "—"}; cambio ${realDeterminism.fixedChangeTime ?? "—"}.`,
    "",
    `El informe se genera sin reloj actual ni valores de benchmark embebidos: lee ambos JSON, conserva sus tasas, contadores, estados, latencias y tamaños, y escribe ` +
      "`benchmarks/benchmark-report.md`."
  ].join("\n");
}

function methodologySection(realWorld, contextCorpus) {
  const contextResult = contextCorpus.results[0];
  const changedDocuments = contextResult.propagation?.changedDocumentCount;
  const queryCount = contextResult.queries?.count;
  const topK = contextResult.queries?.topK;
  return [
    "## Metodología",
    "",
    `- **Fixtures reales:** se leen las expectativas y episodios de ${formatInteger(realWorld.scenarioCount)} escenarios con almacenamiento y mutaciones declarados en el artefacto. La tabla de seguridad usa ` +
      "`pairedMetrics`; la cobertura de casos usa `scenarios`.",
    `- **Corpus de contexto:** se muestran todos los resultados disponibles (${formatInteger(contextCorpus.results.length)} combinaciones de tamaño/patrón), incluyendo propagación, precisión, recuperación de consultas y latencias registradas en cada fila.`,
    `- **Consulta:** el resultado de referencia usa ${formatInteger(queryCount)} consultas y top-k ${formatInteger(topK)} en la primera fila disponible; el informe conserva el conteo de cada fila cuando puede variar.`,
    `- **Mutación y validación:** cada fila de corpus registra ${formatInteger(changedDocuments)} documentos cambiados en su escenario; el validador declarado es el que figura en validator y no se sustituye por una simulación.`,
    "- **Comparabilidad:** las comparaciones directas se limitan a estrategias y fases presentes en los JSON. No se inventan benchmarks before/after, mejoras porcentuales ni puntos de escalado que no estén registrados.",
    "- **Formato:** porcentajes son tasas del artefacto con su conteo; tiempos son milisegundos; memoria se expresa en MB base 1024."
  ].join("\n");
}

function limitationsSection(realWorld, contextCorpus) {
  const limitations = unique([
    ...(realWorld.limitations ?? []).map((limitation) => `Fixtures reales: ${limitation}`),
    ...(contextCorpus.limitations ?? []).map((limitation) => `Corpus de contexto: ${limitation}`)
  ]);
  return [
    "## Limitaciones",
    "",
    ...limitations.map((limitation) => `- ${limitation}`),
    "",
    "Las insignias de estado ayudan a leer el resultado, pero no convierten una medición local en una garantía de producción."
  ].join("\n");
}

function summarySection(realWorld, contextCorpus) {
  const premise = strategyMetrics(realWorld, "PREMiSE");
  const largest = contextCorpus.results.reduce((current, result) => result.nodes > current.nodes ? result : current, contextCorpus.results[0]);
  const finalQuality = largest.metrics.retrievalHitRate;
  return [
    "## Resumen ejecutivo",
    "",
    markdownTable(
      ["Área", "Lectura del artefacto", "Estado"],
      [
        [
          "Seguridad en fixtures reales",
          `${formatInteger(premise.security.unsafeActions)} acciones inseguras en ${formatInteger(premise.denominators.unsafeToUse)} casos inseguros`,
          `${statusIcon("zero", premise.security.unsafeActionRate)} ${formatPercent(premise.security.unsafeActionRate)}`
        ],
        [
          "Efectividad de decisión",
          `${formatInteger(premise.security.correctDecisions)} decisiones correctas de ${formatInteger(premise.episodes)}`,
          `${statusIcon("one", premise.security.correctDecisionRate)} ${formatPercent(premise.security.correctDecisionRate)}`
        ],
        [
          "Escalado máximo registrado",
          `${formatInteger(largest.nodes)} nodos · ${patternLabel(largest.pattern)}`,
          `${statusIcon("one", finalQuality)} hit final ${formatPercent(finalQuality)}`
        ],
        [
          "Aislamiento del corpus",
          `${formatInteger(contextCorpus.invariants?.isolation?.affected?.length ?? 0)} afectados en la comprobación declarada`,
          contextCorpus.invariants?.isolation?.passed ? "✅ superado" : "❌ no superado"
        ]
      ]
    ),
    "",
    "> Las conclusiones anteriores son resúmenes de campos existentes en los dos artefactos; el detalle completo y sus denominadores aparecen en las tablas siguientes."
  ].join("\n");
}

async function main() {
  const [realWorld, contextCorpus] = await Promise.all([
    readJson(sources.realWorld),
    readJson(sources.contextCorpus)
  ]);
  validateInputs(realWorld, contextCorpus);

  const report = [
    "# Informe de benchmarks",
    "",
    "> Informe Markdown reproducible generado desde resultados JSON reales.",
    "",
    summarySection(realWorld, contextCorpus),
    "",
    realWorldSection(realWorld),
    "",
    contextCorpusSection(contextCorpus),
    "",
    sourceSection(realWorld, contextCorpus),
    "",
    methodologySection(realWorld, contextCorpus),
    "",
    limitationsSection(realWorld, contextCorpus),
    ""
  ].join("\n");

  await writeFile(output, report, "utf8");
  console.log(`Escrito ${path.relative(process.cwd(), output)} (${formatInteger(report.length)} caracteres)`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
