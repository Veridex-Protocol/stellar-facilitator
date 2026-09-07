const BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

interface Histogram {
  sum: number;
  count: number;
  buckets: Map<number, number>;
}

export class GatewayMetrics {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();

  constructor() {
    for (const name of [
      "veridex_gateway_requests_total",
      "veridex_gateway_402_total",
      "veridex_gateway_verifications_total",
      "veridex_gateway_settlements_total",
      "veridex_gateway_settlement_failures_total",
      "veridex_gateway_upstream_requests_total",
      "veridex_gateway_upstream_failures_total",
      "veridex_gateway_provider_faults_total",
      "veridex_gateway_bytes_in",
      "veridex_gateway_bytes_out",
      "veridex_gateway_creations_total",
    ]) this.counters.set(name, name === "veridex_gateway_creations_total" ? 1 : 0);
    this.histograms.set("veridex_gateway_upstream_latency", this.histogram());
  }

  increment(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  observe(name: string, seconds: number): void {
    const histogram = this.histograms.get(name);
    if (!histogram) throw new Error(`Unknown histogram: ${name}`);
    histogram.sum += seconds;
    histogram.count += 1;
    for (const bucket of BUCKETS) {
      if (seconds <= bucket) histogram.buckets.set(bucket, (histogram.buckets.get(bucket) ?? 0) + 1);
    }
  }

  render(active: boolean): string {
    const lines: string[] = [];
    for (const [name, value] of this.counters) {
      lines.push(`# TYPE ${name} counter`, `${name} ${value}`);
    }
    lines.push("# TYPE veridex_gateway_active gauge", `veridex_gateway_active ${active ? 1 : 0}`);
    for (const [name, histogram] of this.histograms) {
      lines.push(`# TYPE ${name} histogram`);
      for (const [bucket, count] of histogram.buckets) {
        lines.push(`${name}_bucket{le="${bucket}"} ${count}`);
      }
      lines.push(
        `${name}_bucket{le="+Inf"} ${histogram.count}`,
        `${name}_sum ${histogram.sum}`,
        `${name}_count ${histogram.count}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }

  private histogram(): Histogram {
    return { sum: 0, count: 0, buckets: new Map(BUCKETS.map((bucket) => [bucket, 0])) };
  }
}