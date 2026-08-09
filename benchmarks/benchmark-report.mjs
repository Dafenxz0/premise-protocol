import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const benchmarksDir = path.dirname(fileURLToPath(import.meta.url));
const sources = {
  comparative: path.join(benchmarksDir, "comparative-bench", "results.json"),
  realWorld: path.join(benchmarksDir, "real-world-bench", "results.json"),
  contextCorpus: path.join(benchmarksDir, "context-corpus-bench", "results.json"),
  longContext: path.join(benchmarksDir, "long-context-bench", "results.json")
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

function validateInputs(comparative, realWorld, contextCorpus, longContext) {
  assertInput(comparative?.format, "falta format en comparative-bench/results.json");
  assertInput(Array.isArray(comparative.pairedMetrics) && comparative.pairedMetrics.length > 0, "falta pairedMetrics en comparative-bench/results.json");
  assertInput(realWorld?.format, "falta format en real-world-bench/results.json");
  assertInput(Array.isArray(realWorld.scenarios), "falta scenarios en real-world-bench/results.json");
  assertInput(Array.isArray(realWorld.pairedMetrics), "falta pairedMetrics en real-world-bench/results.json");
  assertInput(realWorld.scenarioCount === realWorld.scenarios.length, "scenarioCount no coincide con scenarios");
  assertInput(contextCorpus?.format, "falta format en context-corpus-bench/results.json");
  assertInput(Array.isArray(contextCorpus.setups), "falta setups en context-corpus-bench/results.json");
  assertInput(Array.isArray(contextCorpus.results), "falta results en context-corpus-bench/results.json");
  assertInput(contextCorpus.results.length > 0, "results está vacío en context-corpus-bench/results.json");
  assertInput(longContext?.format, "falta format en long-context-bench/results.json");
  assertInput(Array.isArray(longContext.profiles) && longContext.profiles.length > 0, "falta profiles en long-context-bench/results.json");
  assertInput(Array.isArray(longContext.results) && longContext.results.length > 0, "results está vacío en long-context-bench/results.json");
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
  const validated = metric.validatorCalls?.validate > 0;
  return [
    metric.strategy,
    `${statusIcon("one", metric.security.correctDecisionRate)} ${formatPercent(metric.security.correctDecisionRate)} (${formatInteger(metric.security.correctDecisions)}/${formatInteger(metric.episodes)})`,
    rateCell(metric.security.unsafeActionRate, metric.security.unsafeActions, metric.episodes, "zero"),
    rateCell(metric.security.falseRejectionRate, metric.security.falseRejections, denominators.safeToUse, "zero"),
    validated ? rateCell(metric.validation.resultMatchRate, metric.validation.resultMatches, denominators.validationCases) : "ℹ️ no medido",
    validated ? rateCell(metric.recovery.validatedRecoveryRate, metric.recovery.validatedRecoveries, denominators.recoveryCandidates) : "ℹ️ no medido",
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
  const afterRepairAffected = result.checks.afterRepairAffected;
  const affectedRate = result.nodes ? result.propagation.affectedNodes / result.nodes : null;
  return [
    formatInteger(result.nodes),
    patternLabel(result.pattern),
    `${formatInteger(result.propagation.affectedNodes)} / ${formatInteger(result.nodes)} (${formatPercent(affectedRate)})`,
    `${statusIcon("one", result.metrics.precision)} ${formatPercent(result.metrics.precision)}`,
    `${statusIcon("one", postSignal.retrievalHitRate)} ${formatPercent(postSignal.retrievalHitRate)}`,
    `${statusIcon("one", result.metrics.retrievalHitRate)} ${formatPercent(result.metrics.retrievalHitRate)}`,
    rateCell(postSignal.safety, postSignal.affectedCandidates - postSignal.unsafeUses, postSignal.affectedCandidates),
    rateCell(postSignal.falseRejectRate, postSignal.falseRejects, postSignal.falseRejectDenominator, "zero"),
    rateCell(postSignal.controlFalseRejectRate, postSignal.controlFalseRejects, postSignal.controlQueryCount, "zero"),
    rateCell(result.metrics.finalSafety, afterRepairAffected.usable, afterRepairAffected.total),
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
      ["Nodos", "Patrón", "Propagación afectada", "Precisión final", "Hit tras señal", "Hit tras reparación", "Seguridad tras señal (candidatos)", "Falso rechazo candidatos", "Falso rechazo controles", "Seguridad tras reparación", "Bloqueadas tras señal"],
      results.map(contextQualityRow),
      [0, 2, 3, 4, 5, 6, 7, 8, 9, 10]
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
    "`Tras señal` muestra la ventana en la que el protocolo bloquea memorias potencialmente obsoletas; `tras reparación` comprueba todos los nodos afectados, no solo el target. La seguridad y los falsos rechazos de candidatos usan denominadores de candidatos; los controles usan denominadores de consultas y se muestran por separado. Las latencias son p50/p95; `Heap Δ firmado` conserva el signo del artefacto. MB se presenta en base 1024.",
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

function statusMark(status) {
  const icons = { FRESH: "✅", STALE: "⚠️", INVALID: "❌", UNKNOWN: "ℹ️" };
  return `${icons[status] ?? "ℹ️"} \`${status ?? "—"}\``;
}

function longContextQualityRow(profile) {
  const affectedRate = profile.nodes ? profile.affectedNodes / profile.nodes : null;
  return [
    formatInteger(profile.nodes),
    patternLabel(profile.topology),
    `${formatInteger(profile.affectedNodes)} / ${formatInteger(profile.nodes)} (${formatPercent(affectedRate)})`,
    `${statusMark(profile.beforeChangeStatus)} → ${statusMark(profile.afterSignalStatus)} → ${statusMark(profile.afterValidateStatus)}`
  ];
}

function longContextCostRow(profile) {
  return [
    formatInteger(profile.nodes),
    patternLabel(profile.topology),
    formatMs(profile.signalMs),
    formatMs(profile.validateMs),
    formatMs(profile.totalMs),
    formatMb(profile.heapDeltaBytes),
    formatMb(profile.externalPayloadBytes)
  ];
}

function longContextSection(longContext) {
  const results = [...longContext.results].sort((left, right) => left.nodes - right.nodes || left.topology.localeCompare(right.topology));
  const patterns = unique(results.map((result) => result.topology));
  const largest = results.reduce((current, result) => result.nodes > current.nodes ? result : current, results[0]);
  return [
    "## Contexto largo y propagación selectiva",
    "",
    `El benchmark de grafo contiene **${formatInteger(longContext.profiles.length)} perfiles de tamaño** y **${formatInteger(patterns.length)} topologías** (${patterns.map(patternLabel).join(", ")}). Mide el ciclo completo: construir metadatos, detectar cambio, propagar obsolescencia y reparar la raíz validada.`,
    "",
    "### Correctitud de propagación",
    "",
    markdownTable(
      ["Nodos", "Topología", "Afectados", "Ciclo de estado"],
      results.map(longContextQualityRow),
      [0, 2]
    ),
    "",
    "### Coste de señal y reparación",
    "",
    markdownTable(
      ["Nodos", "Topología", "Señal", "Validación", "Tiempo total", "Heap Δ", "Payload externo"],
      results.map(longContextCostRow),
      [0, 2, 3, 4, 5, 6]
    ),
    "",
    `En el perfil máximo (${formatInteger(largest.nodes)} nodos, ${patternLabel(largest.topology)}), la señal afecta ${formatInteger(largest.affectedNodes)} nodos y la reparación termina en ${statusMark(largest.afterValidateStatus)}. Aislamiento: ${longContext.invariants?.isolation?.passed ? "✅ superado" : "❌ no superado"}.`,
    "",
    "Las topologías chain/fanout deben propagar el cambio por toda la rama; shared debe afectar solo la rama que comparte la fuente señalada."
  ].join("\n");
}

function comparativeMetricRow(metric) {
  const denominators = metric.denominators ?? {};
  return [
    metric.strategy,
    formatInteger(metric.episodes),
    `${formatPercent(metric.unsafeActionRate)} (n=${formatInteger(denominators.dynamic)})`,
    `${formatPercent(metric.recoveryRate)} (n=${formatInteger(denominators.repairable)})`,
    `${formatPercent(metric.nonRepairableRejectRate)} (n=${formatInteger(denominators.guarded)})`,
    formatInteger(metric.revalidationCalls),
    formatNumber(metric.episodes ? metric.readCalls / metric.episodes : null, 2),
    `p50 ${formatMs(metric.latencyP50Ms)} / p95 ${formatMs(metric.latencyP95Ms)}`,
    `p50 ${formatInteger(metric.memoryP50Bytes)} B / p95 ${formatInteger(metric.memoryP95Bytes)} B`,
    formatPercent(metric.historyPreservationRate)
  ];
}

function comparativeSection(comparative) {
  const metrics = [...comparative.pairedMetrics].sort((left, right) => left.strategy.localeCompare(right.strategy));
  return [
    "## Comparativa emparejada: baseline frente a PREMiSE",
    "",
    `La suite **${comparative.suite}** compara ${formatInteger(comparative.scenarios.length)} episodios con el mismo oráculo. Los denominadores aparecen por métrica para evitar que una tasa de seguridad se confunda con una tasa de recuperación.`,
    "",
    markdownTable(
      ["Estrategia", "Episodios", "Uso inseguro", "Recuperación", "Rechazo no reparable", "Revalidaciones", "Lecturas/episodio", "Latencia", "Memoria", "Historial"],
      metrics.map(comparativeMetricRow),
      [1, 5, 6]
    ),
    "",
    "Interpretación: primero se aplica el gate de seguridad (uso inseguro = 0%); después se comparan recuperación, relecturas, latencia, memoria e historial. El baseline es más barato porque no revalida: esa cifra no constituye una mejora si permite usar memoria obsoleta."
  ].join("\n");
}

function sourceSection(comparative, realWorld, contextCorpus, longContext) {
  const realDeterminism = realWorld.determinism ?? {};
  return [
    "## Fuentes y reproducibilidad",
    "",
    markdownTable(
      ["Artefacto", "Formato", "Runner", "Seed", "Determinismo / ejecución"],
      [
        [
          "`benchmarks/comparative-bench/results.json`",
          comparative.format,
          comparative.runner,
          comparative.seed,
          `episodios emparejados ${comparative.scenarios.length > 0 ? "✅" : "⚠️"}`
        ],
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
        ],
        [
          "`benchmarks/long-context-bench/results.json`",
          longContext.format,
          longContext.runner,
          `${longContext.profiles.length} perfiles`,
          `payload externo ${longContext.payloadBytes > 0 ? "✅" : "⚠️"}; aislamiento ${longContext.invariants?.isolation?.passed ? "✅" : "❌"}`
        ]
      ]
    ),
    "",
    `El runtime reportado para fixtures reales es Node ${realWorld.runtime?.node ?? "—"} y Git ${realWorld.runtime?.git ?? "—"}. Tiempos fijos declarados: protocolo ${realDeterminism.fixedProtocolTime ?? "—"}; cambio ${realDeterminism.fixedChangeTime ?? "—"}.`,
    "",
    `El informe se genera sin reloj actual ni valores de benchmark embebidos: lee los cuatro JSON, conserva sus tasas, contadores, estados, latencias y tamaños, y escribe ` +
      "`benchmarks/benchmark-report.md`."
  ].join("\n");
}

function methodologySection(comparative, realWorld, contextCorpus, longContext) {
  const contextResult = contextCorpus.results[0];
  const changedDocuments = contextResult.propagation?.changedDocumentCount;
  const queryCount = contextResult.queries?.count;
  const topK = contextResult.queries?.topK;
  return [
    "## Metodología",
    "",
    `- **Fixtures reales:** se leen las expectativas y episodios de ${formatInteger(realWorld.scenarioCount)} escenarios con almacenamiento y mutaciones declarados en el artefacto. La tabla de seguridad usa ` +
      "`pairedMetrics`; la cobertura de casos usa `scenarios`.",
    `- **Comparativa emparejada:** se muestran las ${formatInteger(comparative.scenarios.length)} situaciones compartidas por ` +
      "`No protocol` y `PREMiSE`; uso inseguro, recuperación y rechazo no reparable conservan sus denominadores propios.",
    `- **Corpus de contexto:** se muestran todos los resultados disponibles (${formatInteger(contextCorpus.results.length)} combinaciones de tamaño/patrón), incluyendo propagación, precisión, recuperación de consultas y latencias registradas en cada fila.`,
    `- **Consulta:** el resultado de referencia usa ${formatInteger(queryCount)} consultas y top-k ${formatInteger(topK)} en la primera fila disponible; el informe conserva el conteo de cada fila cuando puede variar.`,
    `- **Mutación y validación:** cada fila de corpus registra ${formatInteger(changedDocuments)} documentos cambiados en su escenario; el validador declarado es el que figura en validator y no se sustituye por una simulación.`,
    `- **Contexto largo:** se conservan las ${formatInteger(longContext.results.length)} combinaciones de tamaño/topología del artefacto, con estado antes de señal, después de señal y después de reparación, además de latencias y memoria.`,
    "- **Comparabilidad:** las comparaciones directas se limitan a estrategias y fases presentes en los JSON. No se inventan benchmarks before/after, mejoras porcentuales ni puntos de escalado que no estén registrados.",
    "- **Formato:** porcentajes son tasas del artefacto con su conteo; tiempos son milisegundos; memoria se expresa en MB base 1024."
  ].join("\n");
}

function limitationsSection(comparative, realWorld, contextCorpus, longContext) {
  const limitations = unique([
    ...(comparative.limitations ?? []).map((limitation) => `Comparativa emparejada: ${limitation}`),
    ...(realWorld.limitations ?? []).map((limitation) => `Fixtures reales: ${limitation}`),
    ...(contextCorpus.limitations ?? []).map((limitation) => `Corpus de contexto: ${limitation}`),
    ...(longContext.limitations ?? []).map((limitation) => `Contexto largo: ${limitation}`)
  ]);
  return [
    "## Limitaciones",
    "",
    ...limitations.map((limitation) => `- ${limitation}`),
    "",
    "Las insignias de estado ayudan a leer el resultado, pero no convierten una medición local en una garantía de producción."
  ].join("\n");
}

function summarySection(comparative, realWorld, contextCorpus, longContext) {
  const premise = strategyMetrics(realWorld, "PREMiSE");
  const pairedPremise = strategyMetrics(comparative, "PREMiSE");
  const largest = contextCorpus.results.reduce((current, result) => result.nodes > current.nodes ? result : current, contextCorpus.results[0]);
  const finalQuality = largest.metrics.retrievalHitRate;
  const largestLong = longContext.results.reduce((current, result) => result.nodes > current.nodes ? result : current, longContext.results[0]);
  return [
    "## Resumen ejecutivo",
    "",
    markdownTable(
      ["Área", "Lectura del artefacto", "Estado"],
      [
        [
          "Gate de seguridad emparejado",
          `${formatInteger(pairedPremise.episodes)} episodios · ${formatPercent(pairedPremise.unsafeActionRate)} uso inseguro PREMiSE`,
          pairedPremise.unsafeActionRate === 0 ? "✅ superado" : "❌ no superado"
        ],
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
        ],
        [
          "Propagación de contexto largo",
          `${formatInteger(largestLong.nodes)} nodos · ${patternLabel(largestLong.topology)} · ${formatInteger(largestLong.affectedNodes)} afectados`,
          statusMark(largestLong.afterValidateStatus)
        ]
      ]
    ),
    "",
    "> Las conclusiones anteriores son resúmenes de campos existentes en los cuatro artefactos; el detalle completo y sus denominadores aparecen en las tablas siguientes."
  ].join("\n");
}

async function main() {
  const [comparative, realWorld, contextCorpus, longContext] = await Promise.all([
    readJson(sources.comparative),
    readJson(sources.realWorld),
    readJson(sources.contextCorpus),
    readJson(sources.longContext)
  ]);
  validateInputs(comparative, realWorld, contextCorpus, longContext);

  const report = [
    "# Informe de benchmarks",
    "",
    "> Informe Markdown reproducible generado desde resultados JSON reales.",
    "",
    summarySection(comparative, realWorld, contextCorpus, longContext),
    "",
    comparativeSection(comparative),
    "",
    realWorldSection(realWorld),
    "",
    contextCorpusSection(contextCorpus),
    "",
    longContextSection(longContext),
    "",
    sourceSection(comparative, realWorld, contextCorpus, longContext),
    "",
    methodologySection(comparative, realWorld, contextCorpus, longContext),
    "",
    limitationsSection(comparative, realWorld, contextCorpus, longContext),
    ""
  ].join("\n");

  await writeFile(output, report, "utf8");
  console.log(`Escrito ${path.relative(process.cwd(), output)} (${formatInteger(report.length)} caracteres)`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
