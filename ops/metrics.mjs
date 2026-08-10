const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 2, 5, 10];
const FRESHNESS_STATES = ["FRESH", "STALE", "INVALID", "UNKNOWN"];

function escapeLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labels(values) {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(",");
}

function labelSuffix(values) {
  const rendered = labels(values);
  return rendered.length === 0 ? "" : `{${rendered}}`;
}

function routeLabel(pathname) {
  if (pathname === "/health" || pathname === "/readyz" || pathname === "/metrics") return pathname;
  if (pathname === "/v2/capabilities") return pathname;
  if (pathname === "/v2/query") return pathname;
  if (pathname === "/v2/source-changed") return pathname;
  if (/^\/v2\/memories\/[^/]+\/revalidate$/u.test(pathname)) return "/v2/memories/:id/revalidate";
  if (/^\/v2\/memories\/[^/]+$/u.test(pathname)) return "/v2/memories/:id";
  if (pathname === "/v2/memories") return pathname;
  return "other";
}

export class Metrics {
  constructor() {
    this.requests = new Map();
    this.histograms = new Map();
    this.persistenceFailures = 0;
  }

  observeRequest(method, pathname, status, durationMs) {
    const route = routeLabel(pathname);
    const key = JSON.stringify({ method, route, status });
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    const histogramKey = JSON.stringify({ method, route });
    const histogram = this.histograms.get(histogramKey) ?? { count: 0, sum: 0, buckets: new Map() };
    histogram.count += 1;
    histogram.sum += durationMs / 1000;
    for (const bucket of HISTOGRAM_BUCKETS) if (durationMs / 1000 <= bucket) histogram.buckets.set(bucket, (histogram.buckets.get(bucket) ?? 0) + 1);
    this.histograms.set(histogramKey, histogram);
  }

  recordPersistenceFailure() {
    this.persistenceFailures += 1;
  }

  render({ storeReady, pendingWrites, records }) {
    const lines = [
      "# HELP premise_build_info PREMiSE v2 build information.",
      "# TYPE premise_build_info gauge",
      'premise_build_info{spec_version="premise/2"} 1',
      "# HELP premise_http_requests_total Total HTTP requests handled by PREMiSE.",
      "# TYPE premise_http_requests_total counter"
    ];
    for (const [key, count] of [...this.requests.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const { method, route, status } = JSON.parse(key);
      lines.push(`premise_http_requests_total${labelSuffix({ method, route, status })} ${count}`);
    }

    lines.push("# HELP premise_http_request_duration_seconds Request duration in seconds.", "# TYPE premise_http_request_duration_seconds histogram");
    for (const [key, histogram] of [...this.histograms.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const { method, route } = JSON.parse(key);
      for (const bucket of HISTOGRAM_BUCKETS) lines.push(`premise_http_request_duration_seconds_bucket${labelSuffix({ le: bucket, method, route })} ${histogram.buckets.get(bucket) ?? 0}`);
      lines.push(`premise_http_request_duration_seconds_bucket${labelSuffix({ le: "+Inf", method, route })} ${histogram.count}`);
      lines.push(`premise_http_request_duration_seconds_sum${labelSuffix({ method, route })} ${histogram.sum}`);
      lines.push(`premise_http_request_duration_seconds_count${labelSuffix({ method, route })} ${histogram.count}`);
    }

    const freshness = new Map(FRESHNESS_STATES.map((status) => [status, 0]));
    for (const record of records) {
      const status = record.envelope?.validity?.status;
      if (freshness.has(status)) freshness.set(status, freshness.get(status) + 1);
    }
    lines.push("# HELP premise_freshness_records Loaded memories by freshness state.", "# TYPE premise_freshness_records gauge");
    for (const status of FRESHNESS_STATES) lines.push(`premise_freshness_records${labelSuffix({ status })} ${freshness.get(status)}`);
    lines.push(
      "# HELP premise_store_ready Whether the durable store is ready.",
      "# TYPE premise_store_ready gauge",
      `premise_store_ready ${storeReady ? 1 : 0}`,
      "# HELP premise_store_pending_writes Writes waiting for PostgreSQL acknowledgement.",
      "# TYPE premise_store_pending_writes gauge",
      `premise_store_pending_writes ${pendingWrites}`,
      "# HELP premise_store_persistence_failures_total Failed persistence batches.",
      "# TYPE premise_store_persistence_failures_total counter",
      `premise_store_persistence_failures_total ${this.persistenceFailures}`
    );
    return `${lines.join("\n")}\n`;
  }
}

export { routeLabel };
