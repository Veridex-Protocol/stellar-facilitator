import { describe, expect, it, vi } from "vitest";
import { BazaarService } from "../server.js";

function makeConfig() {
  return {
    port: 0,
    host: "127.0.0.1",
    database: { host: "127.0.0.1", port: 5432, database: "test", user: "test", password: "test" },
    p2p: { listenAddrs: [], heartbeatIntervalMs: 30_000, maxMissedHeartbeats: 3 },
    horizonUrl: "https://horizon-testnet.stellar.org",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    internalToken: "test-internal-token-that-is-long-enough",
    announcedResources: [],
    providerAggregatePublishedThreshold: 100,
    providerAggregateProvisionalThreshold: 20,
    catalogRevalidationIntervalMs: 0,
    catalogRevalidationStaleMs: 60_000,
    catalogRevalidationTimeoutMs: 100,
    catalogRevalidationBatchSize: 10,
    catalogRevalidationAllowedOrigins: [],
    catalogRevalidationTransportOriginMap: {},
  } as any;
}

describe("Bazaar Prometheus metrics", () => {
  it("exports required discovery, provider, and P2P metrics", async () => {
    const service = new BazaarService(makeConfig());
    vi.spyOn((service as any).db, "query").mockResolvedValue({
      rows: [{ searchable: "4", embedding_backlog: "1", oldest_pending_seconds: "12.5" }],
    });

    const response = await service.getApp().request("/metrics");
    const text = await response.text();

    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(text).toContain("veridex_catalog_resources_total 4");
    expect(text).toContain("veridex_embedding_backlog 1");
    expect(text).toContain("veridex_catalog_ingestion_lag 12.5");
    expect(text).toContain("# TYPE veridex_search_latency histogram");
    for (const name of [
      "veridex_catalog_revalidation_failures_total",
      "veridex_search_requests_total",
      "veridex_search_zero_results_total",
      "veridex_provider_observations_total",
      "veridex_provider_faults_total",
      "veridex_provider_disagreements_total",
      "veridex_p2p_messages_total",
      "veridex_p2p_invalid_total",
      "veridex_p2p_replays_total",
      "veridex_liveness_changes_total",
    ]) {
      expect(text).toContain(`# HELP ${name} `);
    }
  });
});