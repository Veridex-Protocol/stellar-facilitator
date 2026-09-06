/**
 * Minimal Prometheus text registry for facilitator-owned signals.
 * License: Apache-2.0
 */

const LATENCY_BUCKETS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60];

interface MetricDefinition {
  help: string;
  type: "counter" | "gauge";
  value: number;
}

interface HistogramDefinition {
  help: string;
  buckets: Map<number, number>;
  count: number;
  sum: number;
}

export class PrometheusRegistry {
  private readonly metrics = new Map<string, MetricDefinition>();
  private readonly histograms = new Map<string, HistogramDefinition>();

  define(name: string, help: string, type: MetricDefinition["type"]): void {
    this.metrics.set(name, { help, type, value: 0 });
  }

  defineHistogram(name: string, help: string, buckets = LATENCY_BUCKETS): void {
    this.histograms.set(name, {
      help,
      buckets: new Map(buckets.map((bucket) => [bucket, 0])),
      count: 0,
      sum: 0,
    });
  }

  increment(name: string, amount = 1): void {
    const metric = this.requireMetric(name);
    metric.value += amount;
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
      for (const [bucket, count] of histogram.buckets) {
        lines.push(`${name}_bucket{le="${bucket}"} ${count}`);
      }
      lines.push(
        `${name}_bucket{le="+Inf"} ${histogram.count}`,
        `${name}_sum ${format(histogram.sum)}`,
        `${name}_count ${histogram.count}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }

  private requireMetric(name: string): MetricDefinition {
    const metric = this.metrics.get(name);
    if (!metric) throw new Error(`Unknown metric: ${name}`);
    return metric;
  }
}

export function createFacilitatorMetrics(): PrometheusRegistry {
  const registry = new PrometheusRegistry();
  registry.define("veridex_verifications_total", "Facilitator verification requests accepted for processing.", "counter");
  registry.define("veridex_settlements_total", "Facilitator settlement requests accepted for processing.", "counter");
  registry.define("veridex_settlement_failures_total", "Settlement requests that returned an unsuccessful result.", "counter");
  registry.defineHistogram("veridex_settlement_latency", "End-to-end settlement handler latency in seconds.");
  registry.define("veridex_sponsored_fee_total", "Confirmed sponsored network fees in stroops when reported by the settlement mechanism.", "counter");
  registry.define("veridex_channel_available", "Settlement signer channels currently available.", "gauge");
  registry.define("veridex_channel_in_use", "Settlement signer channels currently leased.", "gauge");
  registry.define("veridex_channel_quarantined", "Channel accounts excluded after an error or uncertain submission.", "gauge");
  registry.define("veridex_channel_sequence_drift", "Detected channel sequence drift events.", "counter");
  registry.define("veridex_rpc_requests_total", "RPC-dependent verify and settle operations initiated by this process.", "counter");
  registry.define("veridex_rpc_failures_total", "RPC-dependent operations that failed because the upstream endpoint was unavailable.", "counter");
  registry.define("veridex_rpc_disagreements_total", "Conflicting final transaction states reported by independent RPC providers.", "counter");
  return registry;
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(9)));
}