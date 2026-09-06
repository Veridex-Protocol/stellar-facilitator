/**
 * Minimal Prometheus text registry for Bazaar-owned signals.
 * License: Apache-2.0
 */

interface Metric {
  help: string;
  type: "counter" | "gauge";
  value: number;
}

interface Histogram {
  help: string;
  buckets: Map<number, number>;
  count: number;
  sum: number;
}

export class BazaarMetrics {
  private readonly metrics = new Map<string, Metric>();
  private readonly histograms = new Map<string, Histogram>();

  define(name: string, help: string, type: Metric["type"]): void {
    this.metrics.set(name, { help, type, value: 0 });
  }

  defineHistogram(name: string, help: string): void {
    this.histograms.set(name, {
      help,
      buckets: new Map([0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5].map((bucket) => [bucket, 0])),
      count: 0,
      sum: 0,
    });
  }

  increment(name: string, amount = 1): void {
    this.requireMetric(name).value += amount;
  }

  set(name: string, value: number): void {
    this.requireMetric(name).value = value;
  }

  observe(name: string, value: number): void {
    const histogram = this.histograms.get(name);
    if (!histogram) throw new Error(`Unknown histogram: ${name}`);
    histogram.count++;
    histogram.sum += value;
    for (const [bucket, count] of histogram.buckets) {
      if (value <= bucket) histogram.buckets.set(bucket, count + 1);
    }
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, metric] of this.metrics) {
      lines.push(`# HELP ${name} ${metric.help}`, `# TYPE ${name} ${metric.type}`, `${name} ${format(metric.value)}`);
    }
    for (const [name, histogram] of this.histograms) {
      lines.push(`# HELP ${name} ${histogram.help}`, `# TYPE ${name} histogram`);
      for (const [bucket, count] of histogram.buckets) lines.push(`${name}_bucket{le="${bucket}"} ${count}`);
      lines.push(
        `${name}_bucket{le="+Inf"} ${histogram.count}`,
        `${name}_sum ${format(histogram.sum)}`,
        `${name}_count ${histogram.count}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }

  private requireMetric(name: string): Metric {
    const metric = this.metrics.get(name);
    if (!metric) throw new Error(`Unknown metric: ${name}`);
    return metric;
  }
}

export function createBazaarMetrics(): BazaarMetrics {
  const metrics = new BazaarMetrics();
  metrics.define("veridex_catalog_resources_total", "HTTP and MCP resources currently searchable in the local catalog.", "gauge");
  metrics.define("veridex_catalog_ingestion_lag", "Age in seconds of the oldest pending catalog verification row.", "gauge");
  metrics.define("veridex_catalog_revalidation_failures_total", "Catalog rows quarantined after live payment-term revalidation failed.", "counter");
  metrics.define("veridex_embedding_backlog", "Catalog rows awaiting an embedding.", "gauge");
  metrics.define("veridex_search_requests_total", "Hybrid catalog search requests accepted for processing.", "counter");
  metrics.defineHistogram("veridex_search_latency", "Hybrid catalog search handler latency in seconds.");
  metrics.define("veridex_search_zero_results_total", "Hybrid searches that returned no resources.", "counter");
  metrics.define("veridex_provider_observations_total", "Verified provider observations accepted by this Bazaar.", "counter");
  metrics.define("veridex_provider_faults_total", "Accepted provider observations attributed to provider fault.", "counter");
  metrics.define("veridex_p2p_messages_total", "P2P messages received by this Bazaar process.", "counter");
  metrics.define("veridex_p2p_replays_total", "P2P messages rejected specifically as replays.", "counter");
  return metrics;
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(9)));
}