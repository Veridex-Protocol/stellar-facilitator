import { describe, expect, it } from "vitest";
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

describe("Bazaar public error contract", () => {
  it.each([
    ["/discovery/search", 400, "invalid_request"],
    ["/v1/provider", 400, "invalid_request"],
  ])("returns code, reason, retryability, and category from %s", async (path, status, code) => {
    const service = new BazaarService(makeConfig());
    const response = await service.getApp().request(path);
    const body = await response.json() as any;

    expect(response.status).toBe(status);
    expect(body).toMatchObject({ code, reason: expect.any(String), retryable: false, category: "validation" });
    expect(body.reason.trim().length).toBeGreaterThan(0);
  });

  it("returns the canonical unauthorized error for catalog writes", async () => {
    const service = new BazaarService(makeConfig());
    const response = await service.getApp().request("/catalog/ingest", { method: "POST", body: "{}" });

    expect(await response.json()).toMatchObject({
      code: "unauthorized",
      reason: expect.any(String),
      retryable: false,
      category: "validation",
    });
  });
});