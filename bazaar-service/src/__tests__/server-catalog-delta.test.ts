import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { BazaarService } from "../server.js";
import { Announcer } from "../p2p/announcer.js";

const token = "test-internal-token-that-is-long-enough";

function makeConfig() {
  return {
    port: 0,
    host: "127.0.0.1",
    database: { host: "127.0.0.1", port: 5432, database: "test", user: "test", password: "test" },
    p2p: { listenAddrs: [], heartbeatIntervalMs: 30_000, maxMissedHeartbeats: 3 },
    horizonUrl: "https://horizon-testnet.stellar.org",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    internalToken: token,
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

function signedDelta() {
  const announcer = new Announcer(Keypair.random());
  const now = Math.floor(Date.now() / 1000);
  return announcer.createSignedCatalogDelta({
    op: "upsert",
    resourceUrl: "https://provider.example/fx",
    toolName: "",
    payTo: announcer.getPublicKey(),
    network: "stellar:testnet",
    revision: 1,
    issuedAt: now,
    expiresAt: now + 600,
    state: {
      resourceType: "http",
      description: "FX",
      mimeType: "application/json",
      inputSpec: {},
      scheme: "exact",
      asset: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      amount: "100000",
      settlementTx: "a".repeat(64),
    },
  });
}

describe("catalog delta HTTP publication", () => {
  it("publishes a delta after local admission applies it", async () => {
    const service = new BazaarService(makeConfig());
    const delta = signedDelta();
    vi.spyOn((service as any).ingestionWorker, "applyCatalogDelta").mockResolvedValue({ status: "applied" });
    const publish = vi.spyOn((service as any).p2pNode, "publishCatalogDelta").mockResolvedValue(undefined);

    const response = await service.getApp().request("/catalog/delta", {
      method: "POST",
      body: JSON.stringify(delta),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(202);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(delta);
  });

  it.each([
    [{ status: "ignored", reason: "replay" }, 202],
    [{ status: "rejected", reason: "invalid" }, 400],
  ])("does not publish a locally %s delta", async (result, expectedStatus) => {
    const service = new BazaarService(makeConfig());
    vi.spyOn((service as any).ingestionWorker, "applyCatalogDelta").mockResolvedValue(result);
    const publish = vi.spyOn((service as any).p2pNode, "publishCatalogDelta").mockResolvedValue(undefined);

    const response = await service.getApp().request("/catalog/delta", {
      method: "POST",
      body: JSON.stringify(signedDelta()),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(expectedStatus);
    expect(publish).not.toHaveBeenCalled();
  });
});